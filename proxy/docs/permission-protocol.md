# Permission Protocol

> Wire format for user approval of destructive actions initiated by the LLM through the agent loop.

> **Status: implemented.** Both Path A (`NativeAgentLoopService`) and Path B (`runTextualAgentLoop`) gate `write`, `edit`, and `bash` through this protocol. The approval logic lives in `ApprovalGateService` ([approvalGateService.ts](../src/application/services/approvalGateService.ts)).

---

## Why

The agent loop ([agent-loop.md](agent-loop.md)) lets the LLM call workspace actions without round-tripping through the client. Read-only actions (`list`, `read`, `grep`, `glob`) are safe to auto-execute. Destructive actions (`write`, `edit`, `bash`) **must** be confirmed by the user before execution — a hallucinating local model could otherwise overwrite source files or run arbitrary shell commands inside the workspace.

The protocol has three properties:

1. **Path-agnostic**: identical wire format whether the proxy is using Path A (native tool_calls) or Path B (textual XML tags).
2. **Stream-friendly**: the user sees the model's reasoning up to the action, then a clear "waiting for confirmation" state, then either resumed streaming or a rejection message.
3. **No client-side action semantics**: the client only needs to know "the proxy is asking; show a dialog; reply yes/no". It does not need to know what each action does.

---

## Action Classification

The classification lives in [workspaceActions.ts:77-85](../src/infrastructure/workspaceActions.ts#L77-L85), exported as `ACTION_CLASSIFICATION`:

| Action | Class | Behaviour |
|---|---|---|
| `read` | read-only | Auto-execute, no user prompt |
| `list` | read-only | Auto-execute, no user prompt |
| `grep` | read-only | Auto-execute, no user prompt |
| `glob` | read-only | Auto-execute, no user prompt |
| `write` | destructive | Suspend loop, emit `tool_request_pending`, await `/approve` |
| `edit` | destructive | Suspend loop, emit `tool_request_pending`, await `/approve` |
| `bash` | destructive | Suspend loop, emit `tool_request_pending`, await `/approve` |

Both `NativeAgentLoopService` and `runTextualAgentLoop` consult `ACTION_CLASSIFICATION` before executing.

---

## Wire Format

### Custom SSE event from proxy → client

When the proxy is about to execute a destructive action, it emits a **non-standard** Anthropic SSE event named `tool_request_pending` directly into the open response stream (`SseApprovalInteractor` in [sseApprovalInteractor.ts](../src/infrastructure/adapters/sseApprovalInteractor.ts)):

```
event: tool_request_pending
data: {"request_id":"a1b2c3d4e5f6g7h8","action":"write","params":{"path":"src/foo.ts","content":"<file content>"}}
```

The `request_id` is a 16-character hex string generated via `crypto.randomUUID()` with dashes stripped.

After emitting the event, the proxy stops writing to the stream and parks the request in an internal map keyed by `request_id`. The SSE connection stays open.

### HTTP endpoint: client → proxy

The client replies via a new endpoint:

```
POST /v1/messages/:request_id/approve
Content-Type: application/json

{ "approved": true }
```

or

```
POST /v1/messages/:request_id/approve
Content-Type: application/json

{ "approved": false }
```

The proxy responds `200 {"ok":true}` immediately after resolving the parked promise (`ResolveApprovalUseCase` + `SseApprovalInteractor`). The continuation of the agent loop resumes on the original SSE stream, not on this endpoint.

---

## Sequence Diagram

```
chat-extension                proxy                          local LLM
    │                          │                                │
    │  POST /v1/messages       │                                │
    │ ────────────────────────>│                                │
    │                          │                                │
    │                       agent loop                          │
    │                          │  POST chat/completions         │
    │                          │ ──────────────────────────────>│
    │                          │                                │
    │                          │<──────────── tool_call: write  │
    │                          │                                │
    │                          │  emit content_block_start      │
    │                          │  emit input_json_delta         │
    │                          │  emit content_block_stop       │
    │<─────────────────────────│   (client renders "📝 write")  │
    │                          │                                │
    │                          │  emit tool_request_pending     │
    │<─────────────────────────│   {request_id, action, params} │
    │                          │                                │
    │  (modal shown)           │  (loop paused, promise parked) │
    │                          │                                │
    │  user clicks Approve     │                                │
    │  POST /approve           │                                │
    │ ────────────────────────>│                                │
    │<── 200 {"ok":true} ──    │                                │
    │                       resolve(approved=true)              │
    │                          │                                │
    │                       executeAction("write", args)        │
    │                       inject tool result into messages    │
    │                       continue loop                       │
    │                          │  POST chat/completions         │
    │                          │ ──────────────────────────────>│
    │                          │<──────── final assistant text  │
    │                          │                                │
    │                          │  emit text_delta(s)            │
    │                          │  emit message_stop             │
    │<─────────────────────────│                                │
```

If the user rejects (or the timeout fires), the loop receives `false` and re-injects a denial message as the tool result:

```
Action denied by user.
```

The model receives this as a `tool_result` (Path A) or `<observation>` (Path B) and typically responds conversationally — apologising or proposing an alternative approach.

---

## Proxy-Side State

The approval state is managed by `SseApprovalInteractor` ([sseApprovalInteractor.ts](../src/infrastructure/adapters/sseApprovalInteractor.ts)):

```typescript
private readonly pending = new Map<string, (approved: boolean, scope: ApprovalScope) => void>();
```

Lifecycle:

1. `SseApprovalInteractor.request()` generates a `requestId`, emits `tool_request_pending` on the SSE stream, and parks a `Promise` resolver in the map.
2. `ApprovalGateService` `await`s the Promise.
3. `ResolveApprovalUseCase` looks up the entry, calls `resolve(approved, scope)`, removes the entry, and returns `200`.
4. **Timeout**: after 5 minutes the resolver is called with `false` (scope=Once). The agent loop receives the denial, injects it as a tool result, and continues.

There is currently no explicit cleanup on client disconnect — the 5-minute timeout is the sole safety net.

---

## Client-Side Implementation (Claudio)

1. `chat-session.ts` detects `sseEvent.event === "tool_request_pending"` in the SSE loop and calls `handleToolApproval()`.
2. `handleToolApproval()` parses the JSON payload and sends `ToWebviewType.ToolApprovalRequest` to the Angular webview.
3. The `ToolApprovalModalComponent` displays the action details (path, command, content preview) with Deny / Allow buttons.
4. The user's decision triggers `ToExtensionType.ToolApprovalResponse` back to the extension host.
5. The extension host calls `proxyClient.approve(requestId, approved)` — a `POST /v1/messages/:id/approve`.

The SSE stream stays open throughout — the `for await` loop in `chat-session.ts` naturally suspends at the `await handleToolApproval()` call while the proxy waits on the same open connection.

---

## Auto-Approve Allowlist

For workflows where the user trusts the model to perform certain repetitive actions without prompting, an **allowlist** can be placed at `<workspace>/.claudio/auto-approve.json`:

```json
{
  "rules": [
    { "action": "bash", "cmdPattern": "^npm (run )?(build|test|lint)$" },
    { "action": "write", "pathPattern": "^docs/.*\\.md$" }
  ]
}
```

When a destructive action matches a rule, the proxy skips the `tool_request_pending` event and executes immediately. The check is performed inside `ApprovalGateService.request()` via `checkAutoApprove()` ([autoApproveConfig.ts](../src/infrastructure/adapters/autoApproveConfig.ts)), **before** the Promise/modal machinery is invoked. The file is re-read on every request (no caching), so changes take effect immediately without restarting the proxy.

Rule matching:
- `action` must match exactly.
- `pathPattern` (optional): regex tested against `args.path`. Must match if present.
- `cmdPattern` (optional): regex tested against `args.cmd`. Must match if present.
- A rule with no optional fields matches all invocations of that action.

## Plan Mode

Plan mode is a proxy-level flag that blocks all destructive actions (`write`, `edit`, `bash`) without showing a modal — the loop receives an immediate denial. Read-only actions continue to work normally.

Toggle via `POST /plan-mode {"enabled": bool}` or the shield button in the Claudio toolbar. The current state is exposed in `GET /plan-mode` and in the `/config` response (`planMode` field).

**Priority**: plan mode is checked before the auto-approve allowlist. When plan mode is enabled, no destructive action is ever executed, even if a matching allowlist rule exists.

---

## Related Docs

- [Agent Loop](agent-loop.md) — where the protocol fits in the loop iteration
- [Architecture](architecture.md) — overall request flow
