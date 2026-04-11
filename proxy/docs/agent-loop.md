# Agent Loop

> Workspace-aware agentic execution: how the proxy lets local LLMs read and write the codebase, regardless of whether the model supports native tool calling.

## Overview

The **agent loop** is the proxy's mechanism for letting an LLM take iterative actions inside the user's workspace (read files, list directories, search, write, edit, and run shell commands), instead of only answering with the static context it received in the system prompt.

It exists because local LLMs differ from frontier models in two ways:

1. They have a **hard limit** on how many tools they can handle reliably (see [tool-management.md](tool-management.md) for the probe).
2. Many local models cannot use OpenAI-format tool calling at all (`maxTools = 0`) and must be driven through plain text.

The agent loop is the layer that hides both differences from the client (Claude Code or Claudio) by **always emitting standard Anthropic SSE** regardless of how the LLM was actually driven.

---

## Model-Agnostic Dual-Path Architecture

```
                          ┌── Path A: NativeAgentLoopService ──┐
                          │  (maxTools > 0)                    │
                          │  native OpenAI tool_calls          │
chat-extension            │                                    │
        │                 ▼                                    ▼
        │         ┌──────────────────────────┐  ┌──────────────────────┐
   POST /v1/messages──>│ HandleChatMessageUseCase │──>│ workspaceActions.ts │
        ▲         │                          │  │   (shared backend)   │
        │         └──────────────────────────┘  └──────────────────────┘
        │                 ▲                                    ▲
        │                 │                                    │
        │                 └── Path B: runTextualAgentLoop ─────┘
        │                    (maxTools == 0)
        │                    XML tags in plain text
        │
        └── always receives Anthropic-standard SSE:
            content_block_start (tool_use) → input_json_delta → stop
            + custom event "tool_request_pending" if approval needed
```

The client is **fully path-agnostic**: it receives identical Anthropic SSE whether the proxy ran native tool calls or intercepted XML tags from a model that cannot call tools at all.

---

## Routing

The routing lives in `HandleChatMessageUseCase.execute()` ([handleChatMessageUseCase.ts](../src/application/useCases/handleChatMessageUseCase.ts)):

```typescript
if (workspaceCwd) {
  if (maxTools > 0) {
    const handled = await this.nativeLoop.run(writer, openaiReq, workspaceCwd, thinkingEnabled);
    if (handled) return { type: "handled", llmReachable: true };
  } else {
    await runTextualAgentLoop(
      writer, openaiReq, workspaceCwd, thinkingEnabled,
      this.targetUrl, modelId, this.logger,
      (action, args) => this.approvalGate.request(writer, action, args, workspaceCwd),
    );
    return { type: "handled", llmReachable: true };
  }
}
// fall through to normal streaming (no workspace header, or maxTools>0 + nothing produced)
```

Two conditions trigger the loop:

| Condition | Source |
|---|---|
| `workspaceCwd` | Value of the `X-Workspace-Root` HTTP header sent by the client. |
| `this.maxTools` | Result of `ToolProbe.detect()` (or cache hit) at startup. See [tool-management.md](tool-management.md). |

When `workspaceCwd` is absent (e.g. Claude Code without a project, or plain API use) neither path runs and the request goes to normal streaming.

---

## Shared Action Backend

Both paths call the same action implementations. The backend lives in [workspaceActions.ts](../src/infrastructure/workspaceActions.ts).

### Available Actions

| Action | Class | Description |
|---|---|---|
| `list` | read-only | Directory listing, pruning `node_modules`, `.git`, `dist`, `build`, etc. |
| `read` | read-only | File read, hard-capped at `MAX_FILE_BYTES = 50 000`. |
| `grep` | read-only | Regex search across workspace files (up to `MAX_GREP_LINES = 200`). |
| `glob` | read-only | Find files by glob pattern (up to `MAX_GLOB_RESULTS = 500`). |
| `write` | destructive | Create or overwrite a file. Creates intermediate directories. Requires user approval. |
| `edit` | destructive | Replace the first occurrence of `old_string` with `new_string` in a file. Requires user approval. |
| `bash` | destructive | Run a shell command in `workspaceCwd` with a 30-second timeout. Output capped at `MAX_BASH_OUTPUT = 8 000` chars. Requires user approval. |

### The `workspace` OpenAI Tool Definition

A single OpenAI tool slot with an `action` discriminator keeps the tool count at 1, safe even for models with low `maxTools` limits:

```typescript
{
  type: "function",
  function: {
    name: "workspace",
    description: "Access the current workspace. Available actions: list, read, grep, glob, write, edit, bash",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list","read","grep","glob","write","edit","bash"] },
        path:    { type: "string" },
        pattern: { type: "string" },
        include: { type: "string" },
        content: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        cmd:     { type: "string" }
      },
      required: ["action"]
    }
  }
}
```

### Path Safety

`safeResolvePath(workspaceCwd, relativePath)` resolves the path and rejects anything that does not start with the workspace root. Path traversal attempts (e.g. `../../etc/passwd`, absolute paths, symlink escapes) are rejected with an error string — the loop treats the error as a tool result and forwards it to the model.

---

## Path A — `NativeAgentLoopService`

For models with `maxTools > 0`. Lives in `NativeAgentLoopService.run()` ([nativeAgentLoopService.ts](../src/application/services/nativeAgentLoopService.ts)).

### Flow

```
NativeAgentLoopService.run(writer, openaiReq, workspaceCwd, thinkingEnabled):
  │
  ├── Replace client tools with [WORKSPACE_TOOL_DEF] only
  │   tool_choice = "auto"
  │
  ├── Emit: message_start (lazy, on first content)
  │
  └── for i in 0..MAX_ITERATIONS (10):
        │
        ├── i == 0: POST to backend with stream: false (guard iteration)
        │     workspaceCalls.length == 0 && text empty?
        │       YES → return false  ← fall through to normal streaming
        │     workspaceCalls.length == 0 && text present?
        │       YES → emit as synthetic SSE, return true
        │
        ├── i >= 1: POST to backend with stream: true
        │     Forward thinking_delta and text_delta to client in real time
        │     Accumulate tool_calls from stream deltas
        │
        ├── For each workspace tool call:
        │     ├── Destructive action? → await requestApproval()
        │     │     Denied → inject denial as tool result, continue loop
        │     ├── executeAction(args, workspaceCwd) → result string
        │     ├── Emit tool_use SSE block (content_block_start … stop)
        │     └── Append assistant turn + tool result to messages
        │
        └── No tool calls? → emit remaining text, emit message_stop, return true
```

**Iteration 0 is a guard**: it uses `stream: false` to cheaply detect whether the model wants to do anything at all. If neither tool calls nor text are produced, the loop returns `false` and normal streaming takes over — essential for simple queries like "explain this error" that have nothing to do with the workspace.

**Iterations 1+ are streamed**: thinking blocks and text tokens arrive at the client in real time; only tool_calls are "consumed" by the proxy.

---

## Path B — `runTextualAgentLoop`

For models with `maxTools == 0` (e.g. Qwen 3.5 35B). Lives in [textualAgentLoop.ts](../src/application/textualAgentLoop.ts).

### System Prompt Augmentation

When `maxTools == 0`, the system prompt injection performed by `SystemPromptBuilder` ([systemPromptBuilder.ts](../src/application/services/systemPromptBuilder.ts)) appends `TEXTUAL_TOOL_MANUAL` — a short protocol description:

```
You can interact with the workspace by emitting a self-closing XML action tag on its own line:

  <action name="list" path="./src"/>
  <action name="read" path="README.md"/>
  <action name="grep" pattern="parseConfig" path="src/" include="*.ts"/>
  <action name="glob" pattern="**/*.ts"/>

After each action you will receive the result inside an <observation> block.
Wait for the observation before continuing.
Emit exactly one action at a time.
Only emit an action tag when you need to inspect the workspace.
When you have enough information, respond normally without emitting any action tag.
```

### Flow

```
runTextualAgentLoop(res, openaiReq, workspaceCwd, ...):
  │
  ├── Strip any tools/tool_choice from the request
  │   (model doesn't use OpenAI tool_calls)
  │
  ├── Emit: message_start (lazy, on first content)
  │
  └── for i in 0..MAX_ITERATIONS (10):
        │
        ├── POST to backend with stream: true
        │
        ├── parseTextualIteration():
        │     Stream text_delta bytes through a stateful XML parser.
        │     Keep a TAG_LOOKAHEAD=7 byte buffer to handle tag boundaries
        │     that fall across two streaming chunks.
        │
        │     Forward all text NOT part of an action tag as text_delta
        │     to the client in real time.
        │
        │     On complete <action .../> tag detected:
        │       ├── Stop forwarding; pause the stream reader
        │       └── Return {textBeforeAction, actionTag, actionArgs}
        │
        ├── No action tag found? → stream is done, emit message_stop, return
        │
        ├── Convert action tag to synthetic tool_use SSE block
        │     (identical to Path A — client sees same format)
        │
        ├── Destructive action? → await approvalGate()
        │     Denied → inject denial as observation, continue loop
        │
        ├── executeAction(actionArgs, workspaceCwd) → result
        │
        └── Re-inject into messages:
              messages.push({role:"assistant", content: textBeforeAction + "\n" + actionTag})
              messages.push({role:"user", content: "<observation>\n"+result+"\n</observation>"})
              (continues to next iteration)
```

### XML Tag Format

The model emits self-closing `<action>` tags. Attributes drive `executeAction`:

| Attribute | Used by |
|---|---|
| `name` | Always — action name (`list`, `read`, `grep`, `glob`) |
| `path` | `list`, `read`, `grep`, `write`, `edit` |
| `pattern` | `grep` (regex), `glob` (glob pattern) |
| `include` | `grep` (file filter, e.g. `*.ts`) |
| `cmd` | `bash` |
| `content` | `write` (file content; CDATA sections supported) |
| `old_string` | `edit` |
| `new_string` | `edit` |

### Output Normalization

Both Path A and Path B produce identical Anthropic SSE `tool_use` blocks. Clients that understand Anthropic streaming cannot tell which path was used.

---

## Permission Gate

Read-only actions (`list`, `read`, `grep`, `glob`) execute immediately. Destructive actions (`write`, `edit`, `bash`) emit a `tool_request_pending` SSE event and suspend the loop until the user responds.

Full wire format and implementation details: [permission-protocol.md](permission-protocol.md).

---

## System Prompt Injection

The agent loop relies on the proxy having already injected the working directory (and for Path B, the tool manual) into the system prompt. That logic is documented in [system-prompt-injection.md](system-prompt-injection.md).

---

## Known Limitations

1. **Path B compliance is model-dependent**: models with `maxTools == 0` may not consistently follow the XML tag protocol. Quality degrades for models below ~15B parameters.
2. **Iteration 0 is not streamed (Path A)**: the first round always uses `stream: false`. For very simple workspace queries this means a brief delay before the first token.
3. **Sequential tool calls per iteration**: even if a model emits multiple `tool_calls` in one turn, they are executed sequentially.
4. **bash blocks the event loop**: `spawnSync` is used for bash — it blocks the Node.js event loop for up to 30 seconds. Acceptable for a single-user local proxy; would need `execAsync` for a multi-tenant deployment.
5. **Auto-approve allowlist**: per-workspace `.claudio/auto-approve.json` allowlist allows matching actions to execute without a modal. See [permission-protocol.md](permission-protocol.md) for the rule format.

---

## Related Docs

- [Architecture](architecture.md) — overall hexagonal layers and where the loop fits
- [Tool Management](tool-management.md) — `ToolProbe`, `maxTools`, and the persistent cache that drives loop activation
- [System Prompt Injection](system-prompt-injection.md) — what the loop sees in the system prompt before running
- [Permission Protocol](permission-protocol.md) — wire format for approving destructive actions
