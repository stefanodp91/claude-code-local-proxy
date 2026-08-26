# Testing

> How the proxy is tested, what is covered, and what is deliberately not.

---

## Running the suites

```bash
cd proxy
npm test          # 142 tests, ~200 ms
npm run typecheck # type-checks src/ and test/ together
```

No GPU. No LM Studio. No model loaded. No network. That constraint is not an
accident — it is the whole design goal, because it is what lets these tests gate
a pull request. [`scripts/regression.sh`](../scripts/regression.sh) needs a live
backend and therefore never could.

Both run on every push and pull request via
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).

---

## Why `node:test`

`dependencies` in [`package.json`](../package.json) is `{}` and is meant to stay
that way. Deployment is a file copy, and there is no supply chain to audit. No
test framework's conveniences are worth trading that for, so the suites use the
runner built into Node.

The cost is real and worth naming: no snapshot testing, no built-in mocking DSL,
assertion messages that are less pretty than an expect-style library's. In
exchange, `npm ci` on CI installs four dev packages and nothing reaches a
running process.

Mocking turns out not to be missed. `LlmClientPort` and `SseWriterPort` are
already ports, so a fake is an object literal that satisfies an interface. The
hexagonal architecture was paid for during the refactor; the tests are where it
starts paying back.

---

## Test layout

```
proxy/test/
  fakes.ts                     shared test doubles — not a test file
  i18n.test.ts                  5 tests — locale integrity
  toolProbe.test.ts             8 tests — probe outcome triage
  approvalGate.test.ts         20 tests — the write/edit/bash/python gate
  requestTranslator.test.ts    25 tests — Anthropic → OpenAI
  responseTranslator.test.ts   16 tests — OpenAI → Anthropic, non-streaming
  streamTranslator.test.ts     23 tests — the SSE state machine
  toolManager.test.ts          23 tests — selection, overflow, promotion decay
  autoApproveConfig.test.ts    22 tests — the allowlist predicate and the diff read
```

`fakes.ts` holds the `ToolManager`, logger and config doubles the translator
suites share. The runner's glob only matches `*.test.ts`, so it is never
collected as a suite — but `tsconfig.json` includes it, so a fake that drifts
out of shape with the interface it stands in for fails the typecheck instead of
quietly testing nothing.

Tests live beside the source tree rather than inside it, and `tsconfig.json`
includes them, so a test that stops compiling fails `npm run typecheck` as
loudly as a source file would.

### `i18n.test.ts`

Asserts that every key passed to `t()` exists in every locale file, that every
locale is a **flat** `Record<string, string>` — one level, strings only — and
that the locales do not drift apart from one another.

The flatness assertion is the important one. `t()` returns the key itself when a
lookup misses, and locale files come in through `JSON.parse`, which returns
`any`. A key written nested:

```json
{ "tools": { "unsupportedByModel": "..." } }
```

type-checks perfectly, passes every compiler check the project has, and reaches
the user as the literal string `tools.unsupportedByModel`. This suite exists
because that exact mistake was made while adding the tool guard, and was caught
by hand rather than by anything automatic.

Note that `locales/` currently ships **only** `en_US.json` (45 keys), so the
cross-locale drift assertion is trivially satisfied today. It is there for the
second locale, and the per-key and flatness assertions carry the weight in the
meantime. Claudio's webview keeps its own separate `en.json` / `it.json` under
`src/webview-ui/src/assets/i18n/`, which these tests do not cover.

### `toolProbe.test.ts`

Covers the triage of a single probe attempt into `tool_calls` / `no_tool_calls` /
`inconclusive`: a refusal makes the binary search go down, a timeout is retried
rather than believed, an HTTP error is not read as a capability, and a
persistent timeout caps the search **and says so** instead of reporting the cap
as a measurement.

The last test reproduces an observed trace against `qwen/qwen3.8-27b`: a slow
reply at n=48 on a model that comfortably handles 64. Run against the pre-fix
code it reports `actual: 47`.

The bug it locks down came from `catch { return false }`, which made a timeout, a
dropped connection and an HTTP 500 indistinguishable from "the model declined to
emit a tool call". Since a larger tool array means a longer prompt and a slower
reply, timeouts cluster exactly on the boundary the search is trying to find —
so the probe was measuring latency and reporting it as capability.

`ToolProbe` reaches for global `fetch` directly, so the test stubs the global. If
it ever becomes a port like the other outbound calls, that stub disappears.

### `approvalGate.test.ts`

`ApprovalGateService.request()` is the only thing between a local model and
`write` / `edit` / `bash` / `python` on the user's filesystem. It is reached only
for actions classified as Destructive, and decides whether to ask the user or
answer for them. Four things can short-circuit the prompt, and **the order they
are checked in is the behaviour**:

```
plan mode  →  auto mode  →  trusted files  →  allowlist  →  ask the user
```

The suite covers each branch and, just as importantly, asserts that the modal
was *not* raised where it should not be. A gate that asks too often is annoying;
a gate that stops asking is the actual failure, and nothing downstream reports
it — the action simply executes. Roughly half the assertions are therefore on
`prompts.length` rather than on the verdict.

Three behaviours worth calling out, because they are easy to break and hard to
notice:

- **`scope: "once"` must not be remembered.** If the persistence branch stopped
  discriminating on scope, "just this once" would silently become "forever",
  which is precisely the direction that does harm.
- **`scope: "turn"` is deliberately not handled here.** The two agent loops keep
  `allowAllThisTurn` in per-turn state; the gate passes the scope back up and
  keeps nothing. If it started persisting turn grants they would outlive the turn.
- **Plan mode outranks the allowlist.** A plan run that quietly edits files
  because `.claudio/auto-approve.json` said so is not a plan run.

Writing it surfaced a real defect, which is the argument for writing tests in
this order rather than the easy order. See [Workspace containment](#workspace-containment)
below.

### The translator suites

Request, response and stream translation are the path *both* surfaces cross on
every request, which is why they were next after the gate. They divide by how
they fail:

- **`requestTranslator`** — pure and synchronous, and almost everything that can
  break here still produces a request the backend accepts. The two orderings are
  the load-bearing part: tool results must precede the user text that follows
  them, and image parts must precede their caption. Neither is visible in a type.
- **`responseTranslator`** — most of the risk is in what the SDK *refuses*: an
  empty content array, or `end_turn` on a reply that carries tool_use blocks.
  Several backends finish with `"stop"` even when they emitted tool calls, so
  the block contents outrank the reported reason.
- **`streamTranslator`** — the one place where almost-right is worse than wrong.
  The SDK is a parser: a `content_block_delta` on an index that was never started
  breaks the client outright rather than degrading the answer.

The stream suite asserts a single structural invariant on every test —
`assertWellFormed()` — that each delta sits inside a start/stop pair for its own
index and nothing is left open. Most of the bugs below were caught by that
helper rather than by the assertion the test was written for.

It also drives explicit chunk boundaries, because the boundaries are half the
behaviour: a `data:` line split across two network reads has to survive, and a
usage-only chunk arriving *after* `finish_reason` still has to reach the final
`message_delta` — which is exactly why the machine defers its closing events to
`[DONE]`.

### `toolManager.test.ts`

Decides which ~6 of Claude Code's ~40 tools a local model is actually offered.
Everything here fails quietly by construction: the model is never shown the tool
it needed, answers as best it can, and nothing reports that a capability was
withheld.

The suite runs on the **real default weights** — 10 for a core tool, 8 promoted,
5 seen in history, 20 forced — rather than round test numbers, because the
behaviour lives in how they compare. A promoted tool scores 8 against a core
tool's 10, so promotion alone never displaces one; promoted *and* seen in history
is 13, and that does. Since calling a tool through UseTool also puts it in the
history, the documented auto-promotion works — but it works because the bonuses
stack, not because promotion is strong enough by itself. A suite built on 1/2/3
would have proved nothing about the configuration anyone actually runs.

This one found no bugs in the code. It found four in itself: see below.

### `autoApproveConfig.test.ts`

`.claudio/auto-approve.json` is the one file whose entire job is to say *less*
than "ask me every time", and `checkAutoApprove()` is what reads it. Anything
that makes it answer `true` too readily removes a confirmation the user believes
is still in place, and nothing downstream notices — the action simply runs. The
approval gate's own suite replaces this function with a fake, which is exactly
why it went uncovered while the gate around it did not.

These tests use a real temporary directory rather than a filesystem port. The
function's whole purpose is reading a file from a known location; stubbing that
away would leave the part worth testing untested. It costs a few milliseconds
and no network.

It found three bugs — two under [Fail closed](#fail-closed), one under
[Workspace containment](#workspace-containment).

---

## Three bugs the translator suite found

None of them threw, logged, or failed a typecheck. All three were written to be
tests of correct behaviour first, watched to fail, and only then fixed.

### UseTool arguments were accumulated twice

Registering a streamed tool call seeded `arguments` with the first delta's
fragment, and the accumulator below then appended that same fragment again:

```ts
this.toolCalls.set(idx, { arguments: tc.function?.arguments ?? "", … });
// …
if (tc.function?.arguments) existing.arguments += tc.function.arguments;
```

Normal tools never read that field — they stream `tc.function.arguments` through
untouched — so it only hurt `UseTool`, where the accumulated string is what
`rewriteUseToolCall()` has to `JSON.parse`. A call arriving whole in one delta,
the common shape, produced `{"tool":"Grep"}{"tool":"Grep"}`. The parse threw, the
rewrite returned null, and the client received a `UseTool` block it cannot
execute. **The tool overflow path was broken**, silently, and only on the models
low enough on tools to need it.

Worth noting how nearly the suite missed it: the first UseTool test asserted on
the *rewritten name*, which a fake supplies regardless of the string handed to
it. It passed against the bug. What caught it was the fallback test, where the
raw arguments reach the wire. The fake now records every string it is given, and
the tests assert on that.

### Thinking was pinned to block index 0

`handleReasoning()` set `contentIndex = 0` and opened the thinking block there
unconditionally. Reasoning almost always arrives first, so this was right almost
always — but a backend emitting a line of text *before* its reasoning got a
thinking block opened on top of the live text block, and every subsequent text
delta landed on an index that was never started. It now closes an open text block
first (mirroring what `handleContent` already did for thinking) and remembers
which index it used.

### Whitespace padding still opened a text block

The existing guard drops whitespace-only content once a tool call is known
about. The usual order is the reverse — the model emits `"\n\n"` and *then*
calls the tool — so by the time the padding could be recognised the block was
open and the client was already rendering an empty bubble. The proxy README
described this as handled; in streaming it was not. Whitespace that would open a
text block is now held: flushed ahead of the next real text, dropped if a tool
call arrives instead.

---

## Fail closed

Two guards in `checkAutoApprove()` were written as
`pattern && value && !test(value)`. That reads as "check the constraint if there
is one" and means "treat a constraint you cannot check as satisfied".

**A constraint that does not apply to the action.** A `pathPattern` written
against `bash` — which carries a command and never a path — short-circuited to a
match, so

```json
{ "action": "bash", "pathPattern": "^scripts/" }
```

approved *every* shell command without asking. The exact opposite of what it
says, in the file whose only job is to be restrictive. It is an easy rule to
write, and it produces no error, no log line and no visible difference until
something destructive runs unprompted.

**A pattern that does not compile.** `new RegExp()` sat outside the `try` that
covers the read and the parse, so a typo in a pattern threw straight through the
approval gate and took the turn down — despite this function documenting that it
fails quietly on a bad config.

Both now go through one helper that returns `false` when the value is absent and
`false` when the pattern will not compile. A rule stating *no* pattern still
matches everything for its action: that is an explicit blanket, and deliberate.

The change only ever moves in the direction of asking more, which is the safe
direction here — but it is a change, and a config that was silently broader than
written will start prompting.

---

## Workspace containment

The gate recorded a `scope: "file"` grant with:

```ts
const full = resolve(workspaceCwd, args.path);
if (full.startsWith(workspaceCwd)) this.trustedFiles.add(full);
```

`startsWith` is not a containment test. With a workspace at `/ws`, the sibling
path `/ws-evil/secrets.txt` passes it, because the comparison ignores the
directory boundary — so a grant on a file outside the workspace could be
recorded as trusted for the rest of the session.

It was not exploitable: `safeResolvePath()` in `workspaceActions.ts` rejects the
write independently, and does the check correctly (`resolved.startsWith(cwd + "/")`,
plus an outright refusal of absolute and `~` paths). The two layers disagreed
about what "inside the workspace" means, and only the lower one was right.

Both sites in the gate now use `relative()`, which is the containment idiom that
does not depend on separator juggling:

```ts
const rel = relative(resolve(workspaceCwd), fullPath);
return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
```

`loadOldContent()` in `autoApproveConfig.ts` carried the identical check,
deciding whether a file may be read into the approval modal as the "before" side
of a diff. Fixed the same way, pinned by the same kind of test.

The regression test pins the sibling-prefix case specifically. Note that it only
fails when **both** call sites are weak, as they originally were: the fast path
and the insertion each guard independently, so reverting one still leaves the
other refusing. That is defence in depth working as intended, and it is also why
the negative control below had to restore the original code exactly rather than
half of it.

---

## Negative control

Every suite here was verified by breaking the code on purpose and confirming the
tests fail — and fail *narrowly*:

| Reintroduced bug | Expected result | Observed |
|---|---|---|
| Nested locale key | i18n suite fails | 2 of 5 fail |
| `catch { return false }` in `ToolProbe` | Triage tests fail, nothing else | exactly 4 fail |
| `startsWith` containment at both gate sites | Sibling-prefix test fails | exactly 1 fails |
| Persist every scope, not just `file` | `once` and `turn` tests fail | exactly 2 fail |
| Allowlist checked before plan mode | Plan-precedence test fails | exactly 1 fails |
| Re-seed UseTool `arguments` at registration | UseTool tests fail | exactly 3 fail |
| Pin the thinking block to index 0 | Interleaving test fails | exactly 1 fails |
| Drop the held-whitespace buffer | Padding test fails | exactly 1 fails |
| Stop reserving the UseTool slot | Budget and overflow tests fail | exactly 3 fail |
| Reverse tie order in the sort | Every order-dependent test fails | 5 fail |
| Never age promotions | Both decay tests fail | exactly 2 fail |
| Make scoring non-additive | Promotion-stacking test fails | exactly 1 fails |
| Treat an unevaluable constraint as satisfied | Fail-closed tests fail | exactly 2 fail |
| Let an unusable regex propagate | Bad-pattern tests fail | exactly 2 fail |
| `startsWith` containment in `loadOldContent` | Sibling-prefix test fails | exactly 1 fails |

A test suite that has never been seen to fail is decoration. Anything added here
should come with the same check.

### When the control does not fail

Two things look identical from the outside — a test too weak to notice the bug,
and a control that never introduced it. They need opposite fixes, so it is worth
knowing which one you have.

Both happened while writing these suites:

- Reverting the workspace containment check at **one** of its two call sites left
  the approval suite green. The test was fine; the fast path and the insertion
  guard independently, so half the bug is not the bug.
- Breaking the tie sort with `(b.score - a.score) || 1` left the ToolManager
  suite green. V8's insertion sort only moves an element when the comparator
  returns negative, so that comparator does not actually reorder anything.
  `|| -1` does, and then 5 tests fail.

The habit that catches both: when a control comes back green, verify the control
itself before touching the test.

### Four tests that proved nothing

`toolManager.test.ts` was written with a limit of 7 against a set of exactly 7
tools. `selectTools` returns early when `allTools.length <= maxTools`, so no
filtering happened at all: the tool under test was trivially present, the
assertion passed, and four tests verified nothing whatsoever. Two more asserted
on a UseTool description that, with no locale loaded, was the bare string
`useTool.description` — `t()` returns the key on a miss.

Both classes are invisible in a green run. The file now pins the limit in a
named constant with the reason attached, loads the real locale in a `before`
hook, and the tests that depend on filtering assert `useToolDef !== null` as a
guard first. A test that cannot fail is worse than a missing one, because it
occupies the space where the missing one would have gone.

---

## The `pretest` guard

```
npm test → pretest → node --test "test/**/*.test.ts"
```

`node --test` **exits 0 when it matches no files**. A broken glob, or a Node
build without glob support in the runner, would therefore produce a green CI run
that verified nothing at all — the same silent-success failure mode the project
has already hit elsewhere. The `pretest` script counts the matched files and
fails loudly when the count is zero.

---

## Not covered yet

Everything on the original priority list — i18n, the probe, the approval gate,
the translators, `ToolManager`, the allowlist — is now covered. What remains, in
priority order:

1. **The two agent loops** — `nativeAgentLoopService` (Path A) and
   `textualAgentLoop` (Path B). The largest remaining surface, and the one a
   live-backend snapshot still catches best, which is why it sits here rather
   than at the top.
2. **`workspaceActions`** — the filesystem and shell backend. `safeResolvePath()`
   deserves the same treatment the two containment bugs above got, from the other
   direction: it is the check that was *right* both times, and nothing pins it.

Two behaviours are known-uncovered on purpose, both recorded in
[PLAN.md](../../PLAN.md) as decisions rather than gaps: the `tool_choice: "any"`
mapping, and what a stream that ends without `[DONE]` should send.

---

## What `regression.sh` is for

[`scripts/regression.sh`](../scripts/regression.sh) drives a running proxy with
curl and prints a normalized, diffable snapshot — status codes, sorted SSE event
types, JSON key shapes, file counts — deliberately insensitive to LLM
non-determinism. You capture a baseline, make the change, capture again, and
diff. It answers a different question from `npm test`: not "is the translation
logic correct" but "does this particular model still behave the way it did
before the refactor".

Both are useful. Only one can be a merge gate, and conflating them is what let
the proxy ship for months with nothing watching it.
