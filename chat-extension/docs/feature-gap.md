# Feature Gap — Claudio vs. Claude Code

> Verified state of the chat-extension (Claudio) features relative to Anthropic's Claude Code CLI, with precise code references. This document is the starting point for anyone who wants to bring Claudio to functional parity with Claude Code.

> **Scope note**: Claudio is not a one-to-one port of Claude Code. It is a VS Code client for the Anthropic↔OpenAI proxy running on top of local LLM models. However, many Claude Code features are feasible even with local models, and this document tracks which ones are already present, which are missing, and where the logic lives (Claudio itself or the shared proxy).

> **Update this document** whenever a feature is implemented or its status changes. It reflects the code as of 2026-04-12.

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
   approval modal        system prompt injection
                         permission gate
```

This means that some features "missing from the chat-extension" are actually **already implemented in the proxy** but not exploited, or only partially exploited, by the chat-extension.

---

## 2. Things Already PRESENT

| Feature | Where it lives | Evidence |
|---|---|---|
| **Dual-path model-agnostic agent loop** | Proxy | [server.ts:289-306](../../proxy/src/infrastructure/server.ts#L289-L306) — routes to Path A (`runNativeAgentLoop`) for `maxTools > 0` or Path B (`runTextualAgentLoop`) for `maxTools == 0`. Both paths emit identical Anthropic SSE. Documented in [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md). |
| **Rich workspace actions: list/read/grep/glob/write/edit/bash** | Proxy | [workspaceActions.ts](../../proxy/src/infrastructure/workspaceActions.ts) — shared backend for all 7 actions. `write`/`edit`/`bash` require user approval before execution. |
| **Permission gate for destructive actions** | Proxy + Claudio | Proxy emits `event: tool_request_pending` SSE ([server.ts:432-434](../../proxy/src/infrastructure/server.ts#L432-L434)); Claudio intercepts in `chat-session.ts`, forwards to Angular modal; user clicks Allow/Deny; extension POSTs `/approve`. Documented in [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md). |
| **Tool approval modal** | Claudio webview | [`tool-approval-modal/tool-approval-modal.component.ts`](../src/webview-ui/src/app/features/chat/tool-approval-modal/tool-approval-modal.component.ts) — standalone Angular component showing action icon, path/command/content preview, Deny/Allow buttons. |
| **Auto-loaded project context** | Proxy | [server.ts:234-253](../../proxy/src/infrastructure/server.ts#L234-L253) — for `maxTools > 0`: injects `Working directory: <cwd>`; for `maxTools == 0`: adds full `buildWorkspaceContextSummary()` + `TEXTUAL_TOOL_MANUAL`. Documented in [proxy/docs/system-prompt-injection.md](../../proxy/docs/system-prompt-injection.md). |
| **Thinking blocks in streaming** | Proxy + Claudio | [streamTranslator.ts](../../proxy/src/application/streamTranslator.ts) converts `reasoning_content` to Anthropic `thinking` blocks. [proxy-client.ts:54-56](../src/extension/proxy/proxy-client.ts#L54-L56) enables it on the client. Visible as expandable panel in the chat. |
| **Thinking detection per model** | Proxy | `ThinkingDetector` (dual probe): probe #1 verifica `supportsThinking`, probe #2 verifica `thinkingCanBeDisabled`. Cache in `model-cache.json`. `enable_thinking` è sempre esplicito (`true`/`false`) sul backend quando supportato — il disable è effettivo. |
| **Thinking toggle UI** | Claudio webview | Icona `psychology` in `InputAreaComponent`: visibile se `supportsThinking`, disabilitata se `thinkingCanBeDisabled === false`, interattiva altrimenti. Tooltip contestuale. Sync via `SetEnableThinking` message. |
| **Tool probe & dynamic management** | Proxy | `toolProbe.ts` binary search for `maxTools`; `toolManager.ts` dynamic selection + `UseTool` meta-tool for overflow; cache in `proxy/model-cache.json`. Documented in [proxy/docs/tool-management.md](../../proxy/docs/tool-management.md). |
| **Rich slash commands** | Proxy + Claudio | [slashCommandInterceptor.ts](../../proxy/src/application/slashCommandInterceptor.ts) handles 13 proxy-side commands (`/status`, `/version`, `/commit`, `/diff`, `/review`, `/compact`, `/brief`, `/plan`, etc.); [chat-session.ts:347-403](../src/extension/chat-session.ts#L347-L403) handles client-side commands (`/files`, `/copy`, `/branch`, `/commit-push-pr`, etc.). Documented in [slash-commands.md](slash-commands.md). |
| **Session persistence (partial)** | Claudio webview | [message-store.service.ts:223-232](../src/webview-ui/src/app/core/services/message-store.service.ts#L223-L232) uses `vscodeApi.setState`. **Works only within the webview lifecycle**: collapsing the sidebar or reloading VS Code resets the history. See the "ABSENT" section below. |

---

## 3. Things CONFIRMED ABSENT or Limited

| Feature | Status | Evidence |
|---|---|---|
| **Streaming during native agent loop iterations 1+** | FIXED in Path A | [server.ts:465+](../../proxy/src/infrastructure/server.ts#L465) — `runNativeAgentLoop` uses `stream: false` only for iteration 0 (guard); iterations 1+ use `stream: true` and forward text/thinking deltas in real time. |
| **Automatic context compaction** | ABSENT | No token counting in Claudio or the proxy. The `conversation[]` ([chat-session.ts:131](../src/extension/chat-session.ts#L131)) grows unbounded. The proxy-side `/compact` is only a manual prompt enrich, not automatic. |
| **Cross-session memory** | ABSENT | No `MEMORY.md` or persistent equivalent. The only cross-request state on the proxy side is the `promoted` map in ToolManager, in-memory and reset on restart. |
| **Plan mode** | PRESENT | `PlanExitModalComponent` gestisce l'uscita da Plan mode; `SetAgentMode` message sincronizza lo stato Ask/Auto/Plan tra webview ed extension host; `ModeSelectorComponent` mostra un dropdown con dot colorati per ogni modalità. |
| **Visualization of `tool_use` blocks in streaming** | PRESENT | Full pipeline in place: `StreamingService` parses `content_block_start/delta/stop` for `tool_use` blocks → `MessageStoreService` accumulates `rawInput` and parses JSON at completion → `MessageBubbleComponent` renders `<app-tool-use-block>` → `ToolUseBlockComponent` shows icon + label with pulsing animation while pending. |
| **Hooks** | ABSENT | No event-driven hook system (`pre-tool-use`, `post-tool-use`, etc.). |
| **Skills** | ABSENT | Slash commands are hardcoded in the two files above, not markdown-defined loaded at runtime. |
| **MCP (Model Context Protocol)** | ABSENT | No MCP client in either the proxy or Claudio. |
| **Sub-agents** | ABSENT | No independent agent spawning. |
| **TodoWrite / task tracking** | ABSENT | No structured task list management integrated. |
| **Web tools** (WebFetch, WebSearch) | ABSENT | Not implemented. |
| **Worktree isolation** | ABSENT | No git worktree spawn code. |
| **Real session persistence** | PRESENT | `retainContextWhenHidden: true` set in `activation.ts:56` (sidebar collapse is fine). `ChatSession` now restores `conversation[]` from `context.workspaceState` on startup and persists it after every user message, assistant reply, and `/clear`. VS Code reload → history survives. |

---

## 4. What the Model Can Do Today (Model-Dependent Matrix)

| Capability | Models with native tools (e.g. Nemotron@4bit, `maxTools=32`) | Models without tools (e.g. Qwen 3.5 35B, `maxTools=0`) |
|---|---|---|
| On-demand workspace file reading | ✅ via Path A (`runNativeAgentLoop`) | ✅ via Path B (`runTextualAgentLoop`, XML tags) |
| Grep / glob across workspace | ✅ | ✅ (path B, model compliance required) |
| Write / edit / bash with approval | ✅ | ✅ (path B, model compliance required) |
| Streaming of text tokens during loop | ✅ (iter 1+ streamed) | ✅ (all iterations streamed) |
| Streaming of thinking blocks | ✅ (iter 1+ only) | ✅ (streamed, model-dependent) |
| Thinking toggle (enable/disable) | ✅ (se `thinkingCanBeDisabled=true`) | ✅ (se `thinkingCanBeDisabled=true`) |
| Visible `tool_use` blocks in chat UI | ✅ (icona + label + pulsing dot) | ✅ (icona + label + pulsing dot) |
| User approval modal for write/bash | ✅ | ✅ |

The main remaining UI gap is the absence of real-time `tool_use` block rendering in the chat (the user sees the final answer but not the exploration steps).

---

## 5. What's Still Missing

All minimum-gap items are now implemented. The following secondary features are also present:

| Feature | Where | Notes |
|---|---|---|
| **Few-shot examples in tool manual** | Proxy | `TEXTUAL_TOOL_MANUAL` includes two worked examples (list→read→answer, grep→answer) to improve Path B compliance on smaller models. |
| **Auto-approve allowlist** | Proxy | `.claudio/auto-approve.json` with `pathPattern`/`cmdPattern` rules. See [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md). |
| **Context compaction** | Proxy | Automatic sliding-window trim at 80% of model context; sentinel message inserted; no manual action needed. |
| **Plan mode** | Proxy + Claudio | Shield button in toolbar toggles `POST /plan-mode`. Destructive actions blocked without modal. State synced back via `ConfigUpdate`. |

The remaining gaps are full Claude Code parity items (lower priority):

Everything else (skills, MCP, hooks, sub-agents, todo, web tools, cross-session memory) is important for full parity with Claude Code, but lower priority.

---

## 6. High-Level Roadmap (Remaining)

**Full Claude Code parity** (lower priority): cross-session memory, hooks, skills, MCP, sub-agents, TodoWrite, web tools, worktree isolation.

The main remaining UI gap (in the capability matrix above) is automatic context compaction — the conversation grows unbounded until the model's context is saturated.

The full target architecture is in [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md).

---

## Related Docs

- [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md) — dual-path agent loop, action set, routing
- [proxy/docs/system-prompt-injection.md](../../proxy/docs/system-prompt-injection.md) — context auto-loading and tool manual
- [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md) — permission gate wire format
- [proxy/docs/tool-management.md](../../proxy/docs/tool-management.md) — probe + scoring + UseTool
- [architecture.md](architecture.md) — Claudio's internal structure
