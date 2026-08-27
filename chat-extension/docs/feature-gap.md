# Feature Gap — Claudio vs. Claude Code

> Verified state of the chat-extension (Claudio) features relative to Anthropic's Claude Code CLI, with precise code references. This document is the starting point for anyone who wants to bring Claudio to functional parity with Claude Code.

> **Scope note**: Claudio is not a one-to-one port of Claude Code. It is a VS Code client for the Anthropic↔OpenAI proxy running on top of local LLM models. However, many Claude Code features are feasible even with local models, and this document tracks which ones are already present, which are missing, and where the logic lives (Claudio itself or the shared proxy).

> **Update this document** whenever a feature is implemented or its status changes. It reflects the code as of 2026-08-26, re-verified against the source.

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
| **Dual-path model-agnostic agent loop** | Proxy | [handleChatMessageUseCase.ts:319-335](../../proxy/src/application/useCases/handleChatMessageUseCase.ts#L319-L335) — inside `if (workspaceCwd)`, routes to Path A (`NativeAgentLoopService.run()`) for `maxTools > 0` or Path B (`runTextualAgentLoop`) for `maxTools == 0`. Both paths emit identical Anthropic SSE. Documented in [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md). |
| **Rich workspace actions: list/read/grep/glob/write/edit/bash/python/todo/skill** | Proxy | [workspaceActions.ts](../../proxy/src/infrastructure/workspaceActions.ts) — shared backend for the 10 executable actions in `WorkspaceAction` (an 11th, `exit_plan_mode`, is a signal rather than an action). `write`/`edit`/`bash`/`python` require user approval; `todo` and `skill` do not, because neither can name a path outside the one file it owns. |
| **Permission gate for destructive actions** | Proxy + Claudio | Proxy emits `event: tool_request_pending` SSE ([sseApprovalInteractor.ts:53](../../proxy/src/infrastructure/adapters/sseApprovalInteractor.ts#L53)); Claudio intercepts in `chat-session.ts`, forwards to Angular modal; user clicks Allow/Deny; extension POSTs `/approve`. Documented in [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md). |
| **Tool approval modal** | Claudio webview | [`tool-approval-modal/tool-approval-modal.component.ts`](../src/webview-ui/src/app/features/chat/tool-approval-modal/tool-approval-modal.component.ts) — standalone Angular component showing action icon, path/command/content preview, Deny/Allow buttons. |
| **Auto-loaded project context** | Proxy | [systemPromptBuilder.ts](../../proxy/src/application/services/systemPromptBuilder.ts) — interpolates `Working directory: {{cwd}} ({{cwdBase}})` into [`prompts/en_US/agent-base.md`](../../proxy/prompts/en_US/agent-base.md); on the textual path (`maxTools == 0`) `appendTextualTail()` adds `buildWorkspaceContextSummary()` + `TEXTUAL_TOOL_MANUAL`. Documented in [proxy/docs/system-prompt-injection.md](../../proxy/docs/system-prompt-injection.md). |
| **Thinking blocks in streaming** | Proxy + Claudio | [streamTranslator.ts](../../proxy/src/application/streamTranslator.ts) converts `reasoning_content` to Anthropic `thinking` blocks. [proxy-client.ts:54-56](../src/extension/proxy/proxy-client.ts#L54-L56) enables it on the client. Visible as expandable panel in the chat. |
| **Thinking detection per model** | Proxy | `ThinkingDetector` (dual probe): probe #1 checks `supportsThinking`, probe #2 checks `thinkingCanBeDisabled`. Cached in `model-cache.json`. **The probe measures observable behaviour, which is the right method — but do not read a `true` from it as "the proxy can switch thinking off".** Measured on `qwen/qwen3.8-27b` (MLX 4-bit, 2026-08-26): reasoning is emitted unconditionally. Neither top-level `enable_thinking` (the field the proxy actually sends, [requestTranslator.ts:100](../../proxy/src/application/requestTranslator.ts#L100)), nor `chat_template_kwargs.enable_thinking`, nor the Qwen `/no_think` soft switch suppress it. Every entry in `model-cache.json` so far has `thinkingCanBeDisabled: false`. |
| **Thinking toggle UI** | Claudio webview | Icona `psychology` in `InputAreaComponent`: visibile se `supportsThinking`, disabilitata se `thinkingCanBeDisabled === false`, interattiva altrimenti. Tooltip contestuale. Sync via `SetEnableThinking` message. |
| **Tool probe & dynamic management** | Proxy | `toolProbe.ts` binary search for `maxTools`; `toolManager.ts` dynamic selection + `UseTool` meta-tool for overflow; cache in `proxy/model-cache.json`. Documented in [proxy/docs/tool-management.md](../../proxy/docs/tool-management.md). |
| **Rich slash commands** | Proxy + Claudio | [slashCommandInterceptor.ts](../../proxy/src/application/slashCommandInterceptor.ts) handles the 8 proxy-side commands (`/status`, `/version`, `/commit`, `/diff`, `/review`, `/compact`, `/brief`, `/plan`) out of the 15 in `SLASH_COMMAND_REGISTRY`, the single source of truth served via `GET /commands`; [chat-session.ts:551-605](../src/extension/chat-session.ts#L551-L605) handles six of the client-side ones (`/copy`, `/files`, `/simplify`, `/branch`, `/commit-push-pr`, `/pr-comments`), while `/clear` never leaves the webview ([chat-container.component.ts:247](../src/webview-ui/src/app/features/chat/chat-container/chat-container.component.ts#L247)). Documented in [slash-commands.md](slash-commands.md). |
| **Session persistence** | Claudio webview + extension host | [message-store.service.ts:258-260](../src/webview-ui/src/app/core/services/message-store.service.ts#L258-L260) uses `vscodeApi.setState` for the webview's own lifecycle, and `ChatSession` persists `conversation[]` to `context.workspaceState`, restoring it on startup. Sidebar collapse and VS Code reload both survive. |

---

## 3. Things CONFIRMED ABSENT or Limited

| Feature | Status | Evidence |
|---|---|---|
| **Streaming during native agent loop iterations** | FIXED in Path A | [nativeAgentLoopService.ts:222-236](../../proxy/src/application/services/nativeAgentLoopService.ts#L222-L236) — **every** iteration now uses `stream: true` and forwards text/thinking deltas in real time. Iteration 0 no longer runs as a non-streaming probe; it keeps only the fallback-guard role, returning `"fallthrough"` when the model emits nothing at all. |
| **Automatic context compaction** | PRESENT | [`services/contextCompactor.ts`](../../proxy/src/application/services/contextCompactor.ts): at 80% of the model's context window it summarizes via LLM (`SEMANTIC_COMPACT`), falling back to dropping messages, and trims down to 65%. Runs on the incoming request **and between iterations of both agent loops**, so a turn that grows past the window mid-flight is handled rather than rejected by the backend. Tool-call pairing is repaired after any trim. **Remaining limitation:** Claudio's own `conversation[]` is never trimmed — the proxy trims what it sends, the extension keeps everything. |
| **Cross-session memory** | PRESENT (proxy) | `.claudio/MEMORY.md`, configurable via `MEMORY_FILE`, is prepended to the system prompt when it exists — see [proxy/docs/system-prompt-injection.md](../../proxy/docs/system-prompt-injection.md). The model updates it through the ordinary `write` action, so updates pass the approval gate and appear in Claudio's approval modal like any other write. **Claudio-side:** nothing to build — the file is workspace state, not extension state. |
| **Plan mode** | PRESENT | `PlanExitModalComponent` gestisce l'uscita da Plan mode; `SetAgentMode` message sincronizza lo stato Ask/Auto/Plan tra webview ed extension host; `ModeSelectorComponent` mostra un dropdown con dot colorati per ogni modalità. |
| **Visualization of `tool_use` blocks in streaming** | PRESENT | Full pipeline in place: `StreamingService` parses `content_block_start/delta/stop` for `tool_use` blocks → `MessageStoreService` accumulates `rawInput` and parses JSON at completion → `MessageBubbleComponent` renders `<app-tool-use-block>` → `ToolUseBlockComponent` shows icon + label with pulsing animation while pending. |
| **Hooks** | ABSENT | No event-driven hook system (`pre-tool-use`, `post-tool-use`, etc.). |
| **Skills** | ABSENT | Slash commands are hardcoded in the two files above, not markdown-defined loaded at runtime. |
| **MCP (Model Context Protocol)** | ABSENT | No MCP client in either the proxy or Claudio. |
| **Sub-agents** | ABSENT | No independent agent spawning. |
| **TodoWrite / task tracking** | ABSENT | No structured task list management integrated. |
| **Web tools** (WebFetch, WebSearch) | ABSENT | Not implemented. |
| **Worktree isolation** | ABSENT | No git worktree spawn code. |
| **Real session persistence** | PRESENT | `retainContextWhenHidden: true` set in [`activation.ts:72`](../src/extension/activation.ts#L72) and [`chat-panel.ts:29`](../src/extension/webview/chat-panel.ts#L29) (sidebar collapse is fine). `ChatSession` now restores `conversation[]` from `context.workspaceState` on startup and persists it after every user message, assistant reply, and `/clear`. VS Code reload → history survives. |

---

## 4. What the Model Can Do Today (Model-Dependent Matrix)

| Capability | Models with native tool calls (`maxTools > 0`) | Models without them (`maxTools == 0`) |
|---|---|---|
| On-demand workspace file reading | ✅ via Path A (`NativeAgentLoopService.run()`) | ✅ via Path B (`runTextualAgentLoop`, XML tags) |
| Grep / glob across workspace | ✅ | ✅ (path B, model compliance required) |
| Write / edit / bash with approval | ✅ | ✅ (path B, model compliance required) |
| Streaming of text tokens during loop | ✅ (all iterations streamed) | ✅ (all iterations streamed) |
| Streaming of thinking blocks | ✅ (all iterations, model-dependent) | ✅ (streamed, model-dependent) |
| Thinking toggle (enable/disable) | ✅ (se `thinkingCanBeDisabled=true`) | ✅ (se `thinkingCanBeDisabled=true`) |
| Visible `tool_use` blocks in chat UI | ✅ (icona + label + pulsing dot) | ✅ (icona + label + pulsing dot) |
| User approval modal for write/bash | ✅ | ✅ |

Both agent paths now stream `tool_use` blocks to the chat as they happen, so the exploration steps are visible and not just the final answer.

---

## 5. What's Still Missing

All minimum-gap items are now implemented. The following secondary features are also present:

| Feature | Where | Notes |
|---|---|---|
| **Few-shot examples in tool manual** | Proxy | `TEXTUAL_TOOL_MANUAL` includes two worked examples (list→read→answer, grep→answer) to improve Path B compliance on smaller models. |
| **Auto-approve allowlist** | Proxy | `.claudio/auto-approve.json` with `pathPattern`/`cmdPattern` rules. See [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md). |
| **Context compaction** | Proxy | Automatic at 80% of the model context, on incoming requests *and* between agent-loop iterations — see the row in §3. |
| **Plan mode** | Proxy + Claudio | The mode selector posts to `POST /agent-mode` ([proxy-client.ts:194-199](../src/extension/proxy/proxy-client.ts#L194-L199)). Destructive actions blocked without modal. State synced back via `ConfigUpdate`. |

The remaining gaps are full Claude Code parity items (lower priority):

Everything else (skills, MCP, hooks, sub-agents, todo, web tools) is important for full parity with Claude Code, but lower priority.

---

## 6. High-Level Roadmap (Remaining)

**Full Claude Code parity** (lower priority): hooks, skills, MCP, sub-agents, TodoWrite, web tools, worktree isolation.

In-loop compaction, previously the sharpest gap here, now runs in both loops. What is left on the Claudio side is that its own `conversation[]` grows without bound.

The full target architecture is in [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md).

---

## Related Docs

- [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md) — dual-path agent loop, action set, routing
- [proxy/docs/system-prompt-injection.md](../../proxy/docs/system-prompt-injection.md) — context auto-loading and tool manual
- [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md) — permission gate wire format
- [proxy/docs/tool-management.md](../../proxy/docs/tool-management.md) — probe + scoring + UseTool
- [architecture.md](architecture.md) — Claudio's internal structure
