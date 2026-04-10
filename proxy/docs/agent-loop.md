# Agent Loop

> Workspace-aware agentic execution: how the proxy lets local LLMs explore the codebase, and the planned model-agnostic dual-path architecture.

## Overview

The **agent loop** is the proxy's mechanism for letting an LLM take iterative actions inside the user's workspace (read files, list directories, and — in the planned extension — search, write, and execute shell commands), instead of only answering with the static context it received in the system prompt.

It exists because local LLMs differ from frontier models in two ways:

1. They have a **hard limit** on how many tools they can handle reliably (see [tool-management.md](tool-management.md) for the probe).
2. Many local models cannot use OpenAI-format tool calling at all (`maxTools = 0`) and must be driven through plain text.

The agent loop is the layer that hides both differences from the client (Claude Code or Claudio) by **always emitting standard Anthropic SSE** regardless of how the LLM was actually driven.

---

## Activation

The loop is triggered inside the main request handler in [server.ts:272](../src/infrastructure/server.ts#L272):

```
if (this.maxTools > 0 && workspaceCwd) {
  const handled = await this.runAgentLoop(res, openaiReq, workspaceCwd);
  if (handled) return;
}
// fall through to normal streaming
```

Two conditions must hold:

| Condition | Source |
|---|---|
| `this.maxTools > 0` | Result of `ToolProbe.detect()` (or cache hit) at startup. See [tool-management.md](tool-management.md). |
| `workspaceCwd` | Value of the `X-Workspace-Root` HTTP header sent by the client. |

When `maxTools == 0` (e.g. Qwen 3.5 35B), the loop is **skipped entirely** and the request goes through normal streaming. The model only sees whatever was injected statically into the system prompt by the workspace context summary (see [system-prompt-injection.md](system-prompt-injection.md)).

---

## Current Implementation

The whole loop lives in [server.ts:367-444](../src/infrastructure/server.ts#L367-L444) as the `runAgentLoop` private method, plus the `workspace` tool definition and executor in [workspaceTool.ts](../src/application/workspaceTool.ts).

### The `workspace` tool

A single OpenAI tool with a discriminator `action` parameter ([workspaceTool.ts:21-42](../src/application/workspaceTool.ts#L21-L42)):

```typescript
{
  type: "function",
  function: {
    name: "workspace",
    description: "Access files in the current workspace. ...",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read"] },
        path:   { type: "string" }
      },
      required: ["action", "path"]
    }
  }
}
```

Only `list` and `read` are supported. Read is hard-capped at `MAX_FILE_BYTES = 50_000` ([workspaceTool.ts:15](../src/application/workspaceTool.ts#L15)) with the rest truncated.

Path safety is enforced by `safeResolve()` ([workspaceTool.ts:144-149](../src/application/workspaceTool.ts#L144-L149)) which resolves the relative path and rejects anything that does not start with `workspaceCwd`.

### Loop body

```
runAgentLoop(res, openaiReq, workspaceCwd):
  │
  ├── Replace any client-provided tools with [workspace] only
  │   tool_choice = "auto"
  │
  └── for i in 0..MAX_ITERATIONS (10):
        │
        ├── POST to backend with stream: false
        │
        ├── workspaceCalls = response.tool_calls filtered by name === "workspace"
        │
        ├── workspaceCalls.length === 0?
        │     ├── i == 0 && text empty?
        │     │     YES → return false  ← fall through to normal streaming
        │     └── otherwise → emit text as synthetic Anthropic SSE, return true
        │
        └── For each workspace tool call:
              ├── parse {action, path} from arguments
              ├── executeWorkspaceTool() → result string
              ├── append assistant message + tool result to messages
              └── continue loop
```

The loop always replaces the client-supplied `tools` array with **only** `[WORKSPACE_TOOL_DEF]`. This is the "Option A" comment in the code: it prevents the model from calling unhandled tools (which would return `content=null` and break the conversation).

### Synthetic SSE output

When the loop produces a final text response, it emits a complete fake Anthropic SSE stream via `writeSyntheticSse()` ([server.ts:450+](../src/infrastructure/server.ts#L450)):

```
event: message_start    {message: {id, role: "assistant", content: [], model: "proxy-system", ...}}
event: content_block_start  {content_block: {type: "text", text: ""}}
event: content_block_delta  {delta: {type: "text_delta", text: "<final answer>"}}
event: content_block_stop
event: message_delta    {delta: {stop_reason: "end_turn"}}
event: message_stop
```

The client cannot tell this synthetic stream apart from a real model-streamed response — but it is **not actually streamed**: the entire answer arrives in a single delta, after all tool iterations have completed.

### Fallback to normal streaming

If on iteration 0 the model produces neither tool calls nor text content (rare but possible), `runAgentLoop` returns `false` and the main handler falls through to normal streaming ([server.ts:417](../src/infrastructure/server.ts#L417)). This safety valve ensures that conversations which do not need workspace exploration still work.

---

## Known Limitations

The current implementation is functional but has several gaps that limit its usefulness:

1. **Read-only**: only `list` and `read`. No `write`, `edit`, `bash`, `grep`, or `glob`.
2. **No streaming during the loop**: each iteration uses `stream: false` ([server.ts:393-398](../src/infrastructure/server.ts#L393-L398)). The user sees nothing until the final synthetic SSE is emitted, even though the model may have been "thinking" or generating partial text for several seconds.
3. **No permission gate**: every tool call is executed immediately. Acceptable today because all actions are read-only, but blocking before adding any destructive capability.
4. **Tool_use blocks invisible to client**: the synthetic SSE only contains a single text block. Clients never see `tool_use` content blocks, so they cannot show "📂 reading src/main.ts..." in real time.
5. **Single-path**: the loop only fires for `maxTools > 0`. Models without tool support get no agentic exploration at all — only the static workspace summary in the system prompt.
6. **Sequential tool calls only**: even if the model emits multiple tool calls per turn, they are executed sequentially in a single thread ([server.ts:427-437](../src/infrastructure/server.ts#L427-L437)).

---

## Planned: Model-Agnostic Dual-Path Architecture

> **Status: planned, not yet implemented.** Tracking work happens in the user's plan file outside this repository.

The goal is to support **both** kinds of local model — those with native OpenAI tool calling (`maxTools > 0`) and those without (`maxTools == 0`) — through a single shared backend, with the client (Claudio or Claude Code) seeing identical Anthropic SSE either way.

### Diagram

```
                          ┌── Path A: runNativeAgentLoop ──┐
                          │  (maxTools > 0)                │
                          │  native OpenAI tool_calls      │
chat-extension            │                                │
        │                 ▼                                ▼
        │         ┌────────────────┐         ┌──────────────────────┐
   POST /v1/messages──>│ server.ts router│──────>│ workspaceActions.ts│
        ▲         │                │         │   (shared backend)   │
        │         └────────────────┘         └──────────────────────┘
        │                 ▲                                ▲
        │                 │                                │
        │                 └── Path B: runTextualAgentLoop ─┘
        │                    (maxTools == 0)
        │                    XML tags in plain text
        │
        └── always receives Anthropic-standard SSE:
            content_block_start (tool_use) → input_json_delta → stop
            + custom event "tool_request_pending" if approval needed
```

### Components

1. **Shared action backend** — new file `proxy/src/infrastructure/workspaceActions.ts`. Implements `read`, `list`, `grep`, `glob`, `write`, `edit`, `bash` as plain TypeScript functions. Validates path traversal (extending `safeResolve`), enforces timeouts, truncates output. Knows nothing about the agent loop.

2. **Path A — `runNativeAgentLoop`** — refactored from current `runAgentLoop`:
   - Switches inner calls to `stream: true` so token deltas (text + thinking) are forwarded to the client in real time.
   - Parses `tool_calls` incrementally from streaming OpenAI deltas (handling JSON-argument splits across chunks).
   - When a tool call is complete: pauses forwarding, calls the shared backend, injects the result back as a `tool` message, and resumes the loop.
   - `MAX_ITERATIONS` cap unchanged.

3. **Path B — `runTextualAgentLoop`** (new file `proxy/src/application/textualAgentLoop.ts`):
   - System prompt is augmented with a **tool manual** — short instructions teaching the model to emit XML tags inline (e.g. `<action name="read" path="src/foo.ts"/>`).
   - A stateful parser scans the streaming `text_delta` for completed tags. When found, it pauses forwarding, converts the tag into a synthetic Anthropic `tool_use` block, calls the shared backend, formats the result as `<observation>...</observation>` and re-injects it as a new user message, then re-streams the model.
   - Handles tags split across chunks, escapes, and CDATA sections (for `write` content).
   - Same `MAX_ITERATIONS` cap.

4. **Output normalization** — both paths emit identical Anthropic SSE. The client receives standard `content_block_start` / `input_json_delta` / `content_block_stop` for every action, regardless of which path produced it. This is the cardinal constraint: **clients must not need to know which path is in use.**

5. **Permission gate** — an additional custom SSE event (`event: tool_request_pending`) suspends both paths when the model requests a destructive action. See [permission-protocol.md](permission-protocol.md) for the wire format and resume mechanism.

### Routing change

The existing `if (this.maxTools > 0 && workspaceCwd)` check at [server.ts:272](../src/infrastructure/server.ts#L272) becomes:

```
if (workspaceCwd) {
  if (this.maxTools > 0) await this.runNativeAgentLoop(res, openaiReq, workspaceCwd);
  else                   await this.runTextualAgentLoop(res, openaiReq, workspaceCwd);
  return;
}
// fall through only when no workspace context at all
```

Both loops handle their own fall-through (e.g. for plain conversational messages that need no tools).

---

## System Prompt Injection

The agent loop relies on the proxy already having injected the working directory (and, for non-tool models, the static workspace summary) into the system prompt **before** the loop runs. That logic lives at [server.ts:234-250](../src/infrastructure/server.ts#L234-L250) and is documented separately in [system-prompt-injection.md](system-prompt-injection.md).

In Path B the same injection point will also append the tool manual.

---

## Permission Protocol

Read-only actions (`read`, `list`, `grep`, `glob`) auto-execute. Destructive actions (`write`, `edit`, `bash`) suspend the loop and emit a custom SSE event waiting for user approval. Wire format and the `POST /v1/messages/:id/approve` endpoint are documented in [permission-protocol.md](permission-protocol.md).

---

## Related Docs

- [Architecture](architecture.md) — overall hexagonal layers and where the loop fits
- [Tool Management](tool-management.md) — `ToolProbe`, `maxTools`, and the persistent cache that drives loop activation
- [System Prompt Injection](system-prompt-injection.md) — what the loop sees in the system prompt before running
- [Permission Protocol](permission-protocol.md) — planned approval flow for destructive actions
