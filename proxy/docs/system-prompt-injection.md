# System Prompt Injection

> What the proxy automatically prepends to the system prompt of every workspace-aware request, and why.

## Overview

When a client sends `POST /v1/messages` with the `X-Workspace-Root` HTTP header, the proxy enriches the system prompt **before** forwarding the request to the local LLM. This injection has two purposes:

1. **Tell the model where it is** — give it the workspace path so any references to "the project" or "this codebase" have grounding.
2. **Prime its context** — for models without tool calling, hand it a static snapshot of the project (directory listing, `package.json`, README) so it can answer questions about the code without having to ask for files it cannot fetch anyway.

The injection adapts to the model's capabilities: a tool-capable model gets a minimal hint and is left to explore via the agent loop, while a non-tool model gets a complete static summary baked into its prompt.

---

## Where It Happens

The injection is implemented at [server.ts:234-250](../src/infrastructure/server.ts#L234-L250), inside the main request handler, **after** slash command interception and **before** the request is translated to OpenAI format and forwarded.

```typescript
if (workspaceCwd) {
  const pathLine = `Working directory: ${workspaceCwd} (${basename(workspaceCwd)})`;
  const wsContext = this.maxTools === 0
    ? `${pathLine}\n\n${buildWorkspaceContextSummary(workspaceCwd)}`
    : pathLine;

  if (!body.system) {
    (body as any).system = wsContext;
  } else if (typeof body.system === "string") {
    (body as any).system = `${wsContext}\n\n${body.system}`;
  } else if (Array.isArray(body.system)) {
    body.system = [{ type: "text", text: wsContext }, ...body.system];
  }
}
```

The injection is gated by the presence of `workspaceCwd`. If the client did not send `X-Workspace-Root`, the proxy adds nothing — the system prompt is forwarded as-is.

---

## Two Modes Driven by `maxTools`

The shape of the injected text depends on whether the loaded model supports OpenAI tool calling, as detected by `ToolProbe` and stored in `this.maxTools`:

| `maxTools` | Injected content | Rationale |
|---|---|---|
| `> 0` | Just `Working directory: <cwd> (<basename>)` | The model can request additional context on demand via the workspace tool — see [agent-loop.md](agent-loop.md). No need to bloat the prompt up front. |
| `== 0` | `Working directory: ...` + full `buildWorkspaceContextSummary()` output | The model has no way to ask for files later, so the proxy front-loads a project snapshot. |

### Static summary contents

`buildWorkspaceContextSummary()` ([workspaceTool.ts:96-137](../src/application/workspaceTool.ts#L96-L137)) produces a plain-text block with three sections:

1. **Top-level directory listing** — every entry in the workspace root, prefixed with `[dir]` or `[file]`. No recursion.
2. **`package.json` summary** — name, description, and `workspaces` field if present. Parsed via `JSON.parse`; silently skipped on error.
3. **README excerpt** — the first 2000 characters of `README.md` (or `readme.md`), appended with `[truncated]` if cut.

Example output (paraphrased):

```
Workspace structure (top level):
  [dir] proxy
  [dir] chat-extension
  [dir] claude_code
  [file] README.md
  [file] CHANGELOG.md
  [file] .gitignore

package.json: name="anthropic-openai-proxy", description="..."

README.md:
# Claude Code + Local LLM Proxy
...
```

This summary is rebuilt fresh on **every request**. It is not cached. Cost is negligible (a few `readdirSync` + small `readFile` calls).

---

## How It Merges with the Client's System Prompt

The proxy is careful not to overwrite a system prompt the client may have built itself. The merge depends on the shape of `body.system`:

| Existing `body.system` | Result |
|---|---|
| Absent / empty | `body.system = wsContext` (string) |
| String | `body.system = wsContext + "\n\n" + clientSystem` (string) |
| Array of content blocks | A new `{type: "text", text: wsContext}` block is **prepended** |

This preserves whatever the client wanted to say while ensuring the workspace context appears first.

---

## Slash Command Enrichment (Adjacent Mechanism)

The system prompt injection is one of two ways the proxy mutates a request before forwarding. The other is **slash command enrichment**, handled by [slashCommandInterceptor.ts](../src/application/slashCommandInterceptor.ts) and described in [architecture.md § Slash Command Interception](architecture.md#slash-command-interception).

The two mechanisms coexist cleanly because they target different parts of the payload:

- **Slash command enrichment** rewrites the **last user message** (e.g. `/diff` becomes the actual diff text plus a prompt asking the model to explain it).
- **System prompt injection** rewrites the **system field**.

Both run in the same request handler, with slash command interception happening first ([server.ts:215-232](../src/infrastructure/server.ts#L215-L232)) so that the workspace context injection sees the already-rewritten message list if applicable.

---

## Planned: Tool Manual for Path B

> **Status: planned, not yet implemented.**

When the dual-path agent loop lands (see [agent-loop.md § Planned](agent-loop.md#planned-model-agnostic-dual-path-architecture)), the injection logic will gain a third mode: when `maxTools == 0` and the textual agent loop is active, the static workspace summary will be **followed by a "tool manual"** — short instructions teaching the model to emit XML action tags inline:

```
You can take actions in the workspace by emitting XML tags inline:
<action name="read" path="src/foo.ts"/>
<action name="grep" pattern="parseConfig"/>
<action name="bash" cmd="ls -la"/>
After each action you'll receive an <observation>...</observation>
with the result. Continue from there.
```

The manual will be additive — the static summary stays — so the model still gets its initial snapshot but also learns it can request more on demand through the textual protocol. The tool list embedded in the manual will be derived from the same shared action backend (`workspaceActions.ts`) used by both agentic paths, so there is a single source of truth for what actions exist.

---

## Related Docs

- [Agent Loop](agent-loop.md) — how the workspace tool is exposed and iterated
- [Architecture](architecture.md) — where injection sits in the overall request flow
- [Tool Management](tool-management.md) — how `maxTools` is detected
