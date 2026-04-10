# Permission Protocol

> Planned wire format for user approval of destructive actions initiated by the LLM through the agent loop.

> **Status: planned, not yet implemented.** Today the proxy executes every workspace tool call without asking. This is acceptable because the only actions currently exposed are read-only (`list`, `read`). The protocol below is the design that will gate `write`, `edit`, and `bash` once they land.

---

## Why

The agent loop ([agent-loop.md](agent-loop.md)) lets the LLM call workspace actions without round-tripping through the client. Today this is safe because every action is read-only. The planned dual-path architecture will add `write`, `edit`, and `bash` — actions that **must** be confirmed by the user before execution, otherwise a hallucinating local model could overwrite source files or run arbitrary shell commands inside the workspace.

The protocol aims for three properties:

1. **Path-agnostic**: identical wire format whether the proxy is using the native or textual agent loop.
2. **Stream-friendly**: the user sees the model's reasoning up to the action, then a clear "waiting for confirmation" state, then either resumed streaming or a rejection message.
3. **No client-side bookkeeping for action semantics**: the client only needs to know "the proxy is asking; show a dialog; reply yes/no". It does not need to know what each action does.

---

## Action Classification

| Action | Class | Behaviour |
|---|---|---|
| `read` | read-only | Auto-execute, no user prompt |
| `list` | read-only | Auto-execute, no user prompt |
| `grep` | read-only | Auto-execute, no user prompt |
| `glob` | read-only | Auto-execute, no user prompt |
| `write` | destructive | Suspend loop, emit `tool_request_pending`, await `/approve` |
| `edit` | destructive | Suspend loop, emit `tool_request_pending`, await `/approve` |
| `bash` | destructive | Suspend loop, emit `tool_request_pending`, await `/approve` |

The classification lives in the shared action backend (`workspaceActions.ts`, planned), keyed by action name. Both `runNativeAgentLoop` and `runTextualAgentLoop` consult the same lookup before executing.

---

## Wire Format

### Custom SSE event from proxy → client

When the proxy is about to execute a destructive action, it emits a **non-standard** Anthropic SSE event named `tool_request_pending` directly into the open response stream:

```
event: tool_request_pending
data: {
  "request_id": "req_01HXYZ...",
  "action": "write",
  "params": {
    "path": "src/foo.ts",
    "content": "<file content, possibly truncated>"
  },
  "preview": "Will create new file src/foo.ts (1.2 KB)"
}
```

The event is emitted **after** the corresponding `content_block_start` / `input_json_delta` / `content_block_stop` for the `tool_use` block, so the client has already rendered the action in the chat UI by the time the approval prompt appears.

After emitting the event, the proxy stops writing to the stream and parks the request in an internal map keyed by `request_id`.

### HTTP endpoint client → proxy

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

{ "approved": false, "reason": "user clicked cancel" }
```

The proxy responds `204 No Content` immediately after resolving the parked promise. The actual continuation of the agent loop happens on the original SSE stream, not on this endpoint.

---

## Sequence Diagram

```
chat-extension                proxy                          local LLM
    │                          │                                │
    │  POST /v1/messages       │                                │
    │ ────────────────────────>│                                │
    │                          │                                │
    │                       runAgentLoop                        │
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
    │<── 204 No Content ──     │                                │
    │                       resolve(approved=true)              │
    │                          │                                │
    │                       executeWriteAction()                │
    │                       inject tool result into messages    │
    │                       continue loop                       │
    │                          │  POST chat/completions         │
    │                          │ ──────────────────────────────>│
    │                          │<──────── final assistant text  │
    │                          │                                │
    │                          │  emit content_block_start      │
    │                          │  emit text_delta(s)            │
    │                          │  emit message_stop             │
    │<─────────────────────────│                                │
```

If the user rejects, the loop receives `{approved: false}` and re-injects the rejection as a synthetic `tool_result` with content like `Action denied by user: <reason>`. The model can then react conversationally — typically apologising or proposing an alternative.

---

## Proxy-Side State

A new field on `ProxyServer`:

```typescript
private pendingApprovals: Map<string, {
  resolve: (decision: { approved: boolean; reason?: string }) => void;
  createdAt: number;
}> = new Map();
```

Lifecycle:

1. Before parking: `request_id` is generated (e.g. `randomUUID()`).
2. The loop awaits a `Promise` whose resolver is stored in the map.
3. The `/approve` endpoint looks up the entry, calls `resolve(decision)`, and removes the entry.
4. **Cleanup on timeout**: a background sweep (interval 60s) removes entries older than 5 minutes and resolves them with `{approved: false, reason: "timeout"}`. The agent loop sees the timeout, injects a rejection, and continues.
5. **Cleanup on disconnect**: when the SSE response stream is closed by the client (e.g. user navigates away), the parked entry is also resolved with `{approved: false, reason: "client disconnected"}`.

---

## Auto-Approve Allowlist (Future Optional)

For workflows where the user trusts the model to perform certain repetitive actions without prompting, the protocol leaves room for an **allowlist** loaded from `<workspace>/.claudio/auto-approve.json`:

```json
{
  "rules": [
    { "action": "bash", "cmdPattern": "^npm (run )?(build|test|lint)$" },
    { "action": "write", "pathPattern": "^docs/.*\\.md$" }
  ]
}
```

When a destructive action matches a rule, the proxy skips the `tool_request_pending` event and executes immediately. The wire format does not change; the protocol is fully compatible with this optimization.

This is **out of scope for the initial implementation** — the first version always prompts.

---

## Why a Custom SSE Event Instead of a Standard Anthropic One

Anthropic's protocol does not have a "pause stream and wait for client decision" event because Claude's tool use is fundamentally request/response: each tool call ends the assistant turn and the client is responsible for executing the tool and starting a new turn with `tool_result` blocks.

The proxy's agent loop subverts this by executing tools server-side. A custom event lets the proxy keep that ergonomic property (clients do not need to implement an agent loop themselves) while still surfacing approval decisions to the user. Clients that do not understand `tool_request_pending` can safely ignore it — the proxy will eventually time out and the loop will continue as if rejected.

---

## Related Docs

- [Agent Loop](agent-loop.md) — where the protocol fits in the loop iteration
- [Architecture](architecture.md) — overall request flow
