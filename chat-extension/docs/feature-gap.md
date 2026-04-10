# Feature Gap — Claudio vs. Claude Code

> Verified state of the chat-extension (Claudio) features relative to Anthropic's Claude Code CLI, with precise code references. This document is the starting point for anyone who wants to bring Claudio to functional parity with Claude Code.

> **Scope note**: Claudio is not a one-to-one port of Claude Code. It is a VS Code client for the Anthropic↔OpenAI proxy running on top of local LLM models. However, many Claude Code features are feasible even with local models, and this document tracks which ones are already present, which are missing, and where the logic lives (Claudio itself or the shared proxy).

> **Update this document** whenever a feature is implemented or its status changes. It reflects the code at the time of writing.

---

## 1. Architecture: Where Things Live

Claudio is composed of three surfaces, but not all "agentic" features live inside the chat-extension. Many are in the **proxy**, shared between Claudio and the Claude Code CLI:

```
┌─────────────┐         ┌────────┐         ┌───────────┐
│   Claudio   │────────>│  Proxy │────────>│  LM Studio│
│ (chat-ext.) │         │        │         │  (Qwen,   │
│             │         │        │         │  Nemotron)│
└─────────────┘         └────────┘         └───────────┘
   webview UI            agent loop          local LLM
   message-protocol      tool-management
   slash dispatch        slash interception
                         system prompt injection
```

This means that some features "missing from the chat-extension" are actually **already implemented in the proxy** but not exploited, or only partially exploited, by the chat-extension. See the table below.

---

## 2. Things Already PRESENT (some erroneously thought absent in the past)

| Feature | Where it lives | Evidence |
|---|---|---|
| **Native agent loop** | Proxy | [server.ts:367-444](../../proxy/src/infrastructure/server.ts#L367-L444) — `runAgentLoop()` iterates up to 10 times with the `workspace` tool (action `list`/`read`). Activated when `maxTools > 0 && workspaceCwd` ([server.ts:272](../../proxy/src/infrastructure/server.ts#L272)). Documented in [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md). Active for Nemotron@4bit (with `maxTools=32`); disabled for Qwen 3.5 35B (`maxTools=0`). |
| **Auto-loaded project context** | Proxy | [server.ts:234-250](../../proxy/src/infrastructure/server.ts#L234-L250) automatically injects into the system prompt: for tool-capable models, only `Working directory: <cwd>`; for models without tools, the full `buildWorkspaceContextSummary()` (dir listing + package.json + first 2000 chars of README). Documented in [proxy/docs/system-prompt-injection.md](../../proxy/docs/system-prompt-injection.md). Functionally equivalent to loading a project file, even though there is no dedicated `.claudio/...` file. |
| **Thinking blocks in streaming** | Proxy + Claudio | [server.ts:209-210](../../proxy/src/infrastructure/server.ts#L209-L210) enables the flag, [streamTranslator.ts:307-354](../../proxy/src/application/streamTranslator.ts#L307-L354) converts `reasoning_content` OpenAI into Anthropic `thinking` blocks, [proxy-client.ts:54-56](../src/extension/proxy/proxy-client.ts#L54-L56) enables it on the client side. Visible as an expandable panel in the chat. |
| **Tool probe & dynamic management** | Proxy | `toolProbe.ts` does binary search for the model's `maxTools`; `toolManager.ts` does dynamic selection with scoring + `UseTool` meta-tool for overflow; cache in `proxy/model-cache.json`. Documented in [proxy/docs/tool-management.md](../../proxy/docs/tool-management.md). |
| **Rich slash commands** | Proxy + Claudio | [slashCommandInterceptor.ts](../../proxy/src/application/slashCommandInterceptor.ts) handles 13 proxy-side commands (`/status`, `/version`, `/commit`, `/diff`, `/review`, `/compact`, `/brief`, `/plan`, etc.); [chat-session.ts:347-403](../src/extension/chat-session.ts#L347-L403) handles client-side commands (`/files`, `/copy`, `/branch`, `/commit-push-pr`, etc.). Documented in [slash-commands.md](slash-commands.md). |
| **Session persistence (partial)** | Claudio webview | [message-store.service.ts:223-232](../src/webview-ui/src/app/core/services/message-store.service.ts#L223-L232) uses `vscodeApi.setState`. **Works only within the webview lifecycle**: collapsing the sidebar or reloading VS Code resets the history. See the "NEARLY ABSENT" section below. |

---

## 3. Things CONFIRMED ABSENT or Limited

| Feature | Status | Evidence |
|---|---|---|
| **Rich tools** (Write, Edit, Bash, Grep, Glob) | ABSENT | The `WORKSPACE_TOOL_DEF` exposes only `list` and `read` ([workspaceTool.ts:21-42](../../proxy/src/application/workspaceTool.ts#L21-L42)). Independent of which model is loaded. |
| **Streaming during native agent loop** | BROKEN | [server.ts:393-398](../../proxy/src/infrastructure/server.ts#L393-L398) — `runAgentLoop` sends `stream: false` on each iteration and then emits a synthetic final SSE ([server.ts:419-421](../../proxy/src/infrastructure/server.ts#L419-L421)). For models with native tools active, the user sees silence until the loop completes. |
| **Automatic context compaction** | ABSENT | No token counting in Claudio or the proxy. The `conversation[]` ([chat-session.ts:131](../src/extension/chat-session.ts#L131)) grows unbounded. The proxy-side `/compact` is only a manual prompt enrich, not automatic. |
| **Cross-session memory** | ABSENT | No `MEMORY.md` or persistent equivalent. The only cross-request state on the proxy side is the `promoted` map in ToolManager, in-memory and reset on restart. |
| **Permission system** | ABSENT | No per-tool confirmation, no allowlist. Currently acceptable because all actions are read-only. When write/bash are added it becomes a blocker — see [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md) for the design. |
| **Plan mode** | ABSENT | No mode toggle. The proxy-side `/plan` is only a prompt enrich ("think step by step"), not a real mode with tool gating. |
| **Hooks** | ABSENT | No event-driven hook system (`pre-tool-use`, `post-tool-use`, etc.). |
| **Skills** | ABSENT | Slash commands are hardcoded in the two files above, not markdown-defined loaded at runtime. |
| **MCP (Model Context Protocol)** | ABSENT | No MCP client in either the proxy or Claudio. |
| **Sub-agents** | ABSENT | No independent agent spawning. |
| **TodoWrite / task tracking** | ABSENT | No structured task list management integrated. |
| **Web tools** (WebFetch, WebSearch) | ABSENT | Not implemented. |
| **Worktree isolation** | ABSENT | No git worktree spawn code. |
| **Real session persistence** | NEARLY ABSENT | Verified: `vscodeApi.setState` works, but [sidebar-provider.ts](../src/extension/webview/sidebar-provider.ts) **does not set `retainContextWhenHidden`**, and in [chat-session.ts:213-224](../src/extension/chat-session.ts#L213-L224) on `attachView` the extension **overwrites** the webview history with the in-memory `conversation[]`. Result: sidebar collapse → history lost; VS Code reload → history lost. The persistence code exists but is practically inert. |
| **Visualization of `tool_use` blocks in streaming** | ABSENT | [chat-session.ts:295-321](../src/extension/chat-session.ts#L295-L321) handles only `text_delta`. Incoming Anthropic `tool_use` blocks from the proxy are silently ignored. Even when the proxy's native agent loop executes `workspace.list()` and `workspace.read()`, the user in Claudio sees no visual indication of the tool in progress. |

---

## 4. What the Model Can Do Today (Model-Dependent Matrix)

Claudio's behavior depends on which model is loaded in LM Studio and the `maxTools` detected by the probe:

| Capability | Models with native tools (e.g. Nemotron@4bit, `maxTools=32`) | Models without tools (e.g. Qwen 3.5 35B, `maxTools=0`) |
|---|---|---|
| On-demand workspace file reading | ✅ via `runAgentLoop` (workspace tool: list/read) | ❌ only the static summary injected in the prompt |
| Write / edit / shell | ❌ tool not implemented (in both cases) | ❌ tool not implemented |
| Grep / glob | ❌ tool not implemented | ❌ tool not implemented |
| Streaming of final tokens | ❌ broken during native loop | ✅ works normally (loop disabled) |
| Streaming of thinking | ❌ broken during native loop | ✅ works normally |

The most visible inconsistency is around streaming: with a model that supports tools, the user experience is **worse** during the agentic phase (prolonged silence) compared to a model without tools that simply streams thinking + response.

---

## 5. What's Truly Missing to Be a Stable "Junior Agent"

Regardless of the loaded model, the points that block Claudio's real utility as an agent are:

1. **Rich action set**: read/list/grep/glob/write/edit/bash. Today only read/list.
2. **Model-agnostic action exposure**: a mechanism that works both for models with `maxTools > 0` (native tool calling) and `maxTools == 0` (tool emulation via textual parsing). See the plan in [proxy/docs/agent-loop.md § Planned](../../proxy/docs/agent-loop.md#planned-model-agnostic-dual-path-architecture).
3. **Visible token streaming during the agent loop**: no silence gaps for the user.
4. **Permission gate** for destructive actions (write/bash) shared across both agentic paths. See [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md).
5. **Client-side visualization of `tool_use` blocks** in streaming, so the user sees in real time "📂 list .", "📄 read README.md", "🔍 grep parseConfig", etc.

Points 1–4 are **proxy-side** work. Point 5 is **Claudio-side** work (parsing `content_block` `tool_use`/`tool_result` in `chat-session.ts` and the webview).

Everything else (skills, MCP, hooks, plan mode, sub-agents, todo, web tools, cross-session memory, plan mode) is important for "full parity" with Claude Code, but secondary to points 1–5.

---

## 6. High-Level Roadmap

To close the minimum gap for "junior agent":

1. **Shared action backend** on the proxy side: new file `proxy/src/infrastructure/workspaceActions.ts` with read/list/grep/glob/write/edit/bash, path validation, timeout, truncation.
2. **Path A**: refactor of `runAgentLoop` for real streaming during iterations and to handle the new actions.
3. **Path B**: new `runTextualAgentLoop` for models with `maxTools == 0`, based on parsing inline XML tags emitted by the model in plain text.
4. **Output normalization**: both paths produce standard Anthropic SSE towards the client. Claudio doesn't know which path is in use.
5. **Tool_use visualization**: extension of `chat-session.ts` and new Angular component to show `tool_use` blocks in chat as they arrive.
6. **Permission gate**: custom SSE event `tool_request_pending` + endpoint `POST /v1/messages/:id/approve` + Angular confirmation modal.
7. **Update this document** after each step.

The complete target architecture is in [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md).

---

## Related Docs

- [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md) — current agent loop and dual-path roadmap
- [proxy/docs/system-prompt-injection.md](../../proxy/docs/system-prompt-injection.md) — context auto-loading in the system prompt
- [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md) — planned permission gate
- [proxy/docs/tool-management.md](../../proxy/docs/tool-management.md) — probe + scoring + UseTool
- [architecture.md](architecture.md) — Claudio's internal structure
