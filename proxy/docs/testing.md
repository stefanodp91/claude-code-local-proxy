# Testing

> How the proxy is tested, what is covered, and what is deliberately not.

---

## Running the suites

```bash
cd proxy
npm test          # 412 tests, ~4 s
npm run typecheck # type-checks src/ and test/ together
```

No GPU. No LM Studio. No model loaded. No network. That constraint is not an
accident — it is the whole design goal, because it is what lets these tests run
on any machine, on any commit, in well under a second.
[`scripts/regression.sh`](../scripts/regression.sh) needs a live backend and
therefore never could.

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs both, **on
request only** — `gh workflow run ci.yml --ref <branch>`. Nothing runs
automatically per commit, which moves the whole weight of the gate onto running
the two commands above before committing.

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
  workspaceFileRepository.test.ts 8 tests — reading the files a workspace keeps for the model
  toolProbe.test.ts             8 tests — probe outcome triage
  workspaceTool.test.ts         9 tests — the static summary Path B leans on
  planExitInjection.test.ts    12 tests — handing an approved plan back to the model
  lifecycle.test.ts            15 tests — starting and stopping a proxy, for both surfaces
  startupDetectors.test.ts     21 tests — what the model can do, decided once at startup
  todo.test.ts                 13 tests — the list the model keeps for itself
  systemPromptBuilder.test.ts  15 tests — what every request is prefixed with
  actionOutcome.test.ts        15 tests — where an action's image goes
  responseTranslator.test.ts   16 tests — OpenAI → Anthropic, non-streaming
  approvalGate.test.ts         20 tests — the write/edit/bash/python gate
  handleChatMessage.test.ts    21 tests — the routing decision itself
  slashCommandInterceptor.test.ts 21 tests — the commands the proxy answers itself
  textualAgentLoop.test.ts     21 tests — Path B, the XML-tag loop
  autoApproveConfig.test.ts    22 tests — the allowlist predicate and the diff read
  streamTranslator.test.ts     23 tests — the SSE state machine
  toolManager.test.ts          23 tests — selection, overflow, promotion decay
  contextCompactor.test.ts     24 tests — trimming a conversation to fit the window
  requestTranslator.test.ts    25 tests — Anthropic → OpenAI
  nativeAgentLoop.test.ts      29 tests — Path A, the native tool-call loop
  workspaceActions.test.ts     46 tests — the filesystem and shell backend
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

### `workspaceActions.test.ts`

Where the model's intentions become changes on disk. Two properties carry the
weight: `safeResolvePath()` is the real containment boundary — the one that was
*right* both times the check was wrong elsewhere — and `executeAction()` promises
never to throw, because every failure is a string the model reads and reacts to,
while a thrown error ends the turn. The last test walks eight failing calls and
asserts only that each came back as a string.

It found two bugs, in [Two ways an edit went wrong](#two-ways-an-edit-went-wrong).

---

## Two ways an edit went wrong

**A dollar sign in the replacement was not a dollar sign.**
`content.replace(old_string, new_string)` treats `$$`, `$&`, `` $` `` and `$'`
inside the *replacement* as patterns rather than text: `$$` collapses to `$`,
`$&` expands to the text being replaced, `$'` to everything after it. An edit
inserting Makefile or shell source therefore wrote something other than what was
asked for, reported `Replaced 1 occurrence`, and left no trace. Passing a
replacer function inserts the string literally.

**A trailing slash on the workspace root locked the model out entirely.** The
containment test appends a separator — `resolved.startsWith(root + sep)` — so a
root arriving as `/ws/` from the `X-Workspace-Root` header was compared against
`/ws//` and *every* path in the workspace read as an escape. Every action would
have failed with "outside the workspace root", which is about as confusing as a
correct-sounding error gets. `resolve()` on the root normalises it.

### `textualAgentLoop.test.ts`

Path B, for models with no native tool calls: the model writes `<action …/>`
tags into ordinary prose and the loop intercepts them mid-stream. The suite
drives the real loop with a scripted LLM and a real temporary workspace, and
asserts on both what reached the client and what reached disk.

The grammar the parser accepts and the grammar `TEXTUAL_TOOL_MANUAL` teaches the
model are written in two different files, and nothing connected them. When they
disagree the model does exactly as instructed and the action silently does not
happen — see [Two grammars that had drifted apart](#two-grammars-that-had-drifted-apart).
One test now derives the attribute list from the manual and asks `parseActionTag`
about each one, so they cannot drift again.

### `nativeAgentLoop.test.ts`

Path A, the loop that runs on a model with native tool calls — the one exercised
every day, and the only suite so far that found nothing. Three properties carry
the weight:

- **The fallthrough contract.** `run()` returns `"fallthrough"` when the model
  produced nothing at all on iteration 0, and the caller retries the turn as an
  ordinary completion. `"handled"` there means the user gets silence;
  `"fallthrough"` after anything has been written means they get the turn twice.
  One test asserts the outcome, another asserts the wire stayed *empty*.
- **Batched execution.** Read-only calls run in parallel, destructive ones
  strictly in sequence, and the results are reassembled in the order the model
  asked. Counting prompts proves nothing here — two writes ask twice either way
  — so the test measures whether a second modal opens while the first is still
  waiting.
- **The iteration ceiling.** Asserted as a message the user can read, not just
  a stream that stops.

Plus plan mode letting only the plan file through, and a JSON body arriving in
answer to a `stream: true` request, which LM Studio does often enough that
ignoring it would lose whole turns.

### `contextCompactor.test.ts`

Trimming a conversation to fit the model's window. The property under test is
not "the conversation got shorter" but "**it got shorter and is still a valid
conversation**", because compaction runs exactly when a conversation is long,
which in this proxy means exactly when it is full of tool calls and their
results — see [Trimming that breaks the conversation](#trimming-that-breaks-the-conversation).

Both message shapes are covered, since compaction now runs on both sides of the
translation: the incoming Anthropic request, and each agent loop trimming its own
OpenAI history between iterations.

Four of its tests are about images rather than pairing — see
[An image counted as prose](#an-image-counted-as-prose).

One test in this suite was rewritten after it passed. The first version built a
history of evenly-sized call/result pairs, so messages dropped two at a time and
the pairing survived by arithmetic rather than by the code being right — it
passed against the bug. The version that ships makes the call enormous and its
answer tiny, so exactly one message is dropped and the cut lands in the middle of
a pair every time.

### `handleChatMessage.test.ts`

21 tests on the routing decision — the largest gap this document used to list.
It is the code that decides *which proxy the client is talking to*: Path A with
a workspace root and a tool-capable model, Path B when the probe says the model
cannot emit tool calls, and a pure translator with no header at all.

None of the ways it can be wrong throw. Claudio silently loses its agent; the
CLI silently receives a system prompt written for Claudio and is told about a
workspace tool it does not have; a `"fallthrough"` treated as `"handled"` leaves
the user with silence. So every assertion here is about *which* branch ran:
Path A is a stub that records its calls, and Path B is told apart by the request
that reaches the fake backend — it strips `tools` from a request the plain
forward would carry through.

Also covered: the capability guard (tools + `maxTools === 0` + no workspace →
400, and the two neighbouring cases that must *not* 400), the three shapes a
system prompt can arrive in, the budget handed to compaction (`0` when the
backend exposes no metadata — a guess would be worse), and the four ways the
backend's answer comes back: an error with its status, a connection that never
opened (502, never status 0), a backend that ignores `stream: true` and replies
JSON, and a streamed answer.

---

## The list the model keeps for itself

`todo` is the first of the parity features, and it was chosen first because it is
the cheapest thing that addresses what a 27B model is actually bad at: it does
three of five steps and then answers as though it had done five.

Two decisions are pinned by the suite rather than argued in a comment. **The
action takes no path** — it writes the one configured file under `.claudio/` and
can be pointed nowhere else — and that is the whole reason it is auto-approved
instead of raising a modal per ticked box. A test passes it a `path` and asserts
it goes nowhere. **An empty list injects nothing**, the same rule as memory,
because a heading saying there is nothing to say is spent on every request of the
turn.

`FsWorkspaceFileRepository` is one class serving both the memory file and the
list: same shape, same failure modes, and keeping them apart is how the second
copy would have drifted.

Measured against the live model, twice, which is what turns a plausible feature
into a known one:

- a **three-step** task: no list, done directly — and that is right, not a miss;
- a **six-step** task with no mention of the feature in the prompt: the model
  wrote the list as its third action, worked through all six, and rewrote it at
  the end with every box ticked. All five files edited, the README created.

**And a control that came back green found a real gap.** Removing the
"empty list injects nothing" guard changed nothing, because the suite tested the
*repository* returning null and never the *builder* turning that into an empty
section. Three tests later it fails as it should. That is the fourth time a green
control has been worth more than a red one.

---

## One rule, one home

`lifecycle.ts` exists because its rules existed twice: in TypeScript inside
Claudio's `ProxyManager`, and in bash inside `start_agent_cli.sh`. Both found a
free port, both wrote a PID file, both killed the proxy by that pid — and both
were wrong the same way, because `npm run start` makes node a *grandchild*. One
copy was fixed when CI hung on it; the other kept the bug, because nothing
connected them.

Now the rules live in the proxy and both surfaces call them: Claudio imports the
module, and the launcher shells out to `src/cli/lifecycle.ts`. What each surface
still owns is what it really owns — Claudio pipes the proxy's output into a VS
Code channel and raises banners, the launcher writes a log file and prints
colours.

The suite covers what a rule has to get right: an occupied port is stepped over,
a PID file is named after the directory it belongs to (one shared file would have
two windows killing each other's proxy), a group kill takes the grandchild, a
stale or unreadable PID file is cleared rather than obeyed, and a health wait
ends the moment the process it is waiting for is known to be dead.

That last one has a measurable cost attached: reverting it makes the test take
its full thirty seconds, which is exactly what the user used to spend watching a
spinner for a proxy that had already exited.

`ProxyManager` lost 57 lines to this, and its suite got faster — the shared wait
polls twice a second where the private copy polled once.

---

## `0` and `false` are answers

`ToolLimitDetector` and `ThinkingDetector` each ask a question that costs real
time — a binary search over live requests, and two more requests after it — and
cache the answer under the model's id. Everything downstream stands on those
numbers: `maxTools` chooses Path A or Path B, and the thinking flags decide
whether Claudio offers a toggle that does anything.

The failures are quiet in opposite directions. A cache that is not read means
probing on every launch, which nobody reports as a bug — the proxy just feels
slow to start. A cache read *wrongly* is worse, and the interesting values are
the falsy ones: `maxTools: 0` is the probe saying "this model could not manage a
single tool", and `supportsThinking: false` is a measured answer, not a missing
one. Both files check `!== undefined` for exactly that reason, and the suite
pins it: reverting either to a truthiness check fails precisely the tests about
zero and false.

`fetch` is stubbed and **counted** here, because "the expensive path was skipped"
is the property and a call count is the only way to see it. The probes have their
own suites; this one is about the orchestration around them — including that the
two detectors write into the same cache record and must not overwrite each
other's half.

---

## The plan that was explained instead of executed

Plan mode is the flow that crosses both packages, and running it live on
2026-08-27 was the first time anyone had. Three faults, all in the six lines of
`server.ts` that read the plan back after the user approves it — the part no
suite could see, because it lived in the wiring.

**It said nothing about what the plan was for.** The text was prepended as
`[Existing plan from …]` and nothing else, so the model read it and *explained it
back*, changing not one file. Measured twice, then fixed and measured again: with
a preamble saying the user approved it and it is to be carried out now, the same
model on the same task edited the file. That before/after is the whole
justification for the change.

**It skipped any message made of content blocks.** Claudio sends an array
whenever the message carries an attachment, and the code handled only a string —
so approving a plan with a file attached ran the turn with no plan at all.

**Its containment was `startsWith(workspaceCwd)`** — the fourth copy of that
mistake in this repo, and the first one that reads a file whose path a client
supplies. For a workspace of `/ws`, `/ws-evil/secret.md` passes and its contents
go into the prompt.

The logic now lives in `application/services/planExitInjection.ts` with 12 tests,
which is also the point: it moved out of the untested wiring into a unit.

`chat-extension/scripts/plan-mode-e2e.ts` drives the whole flow against a live
model. It retries the planning turn, and that is itself a finding: **plan mode is
model-dependent**. Across runs this model wrote a plan and stopped, wrote a plan
and called `exit_plan_mode`, and called `exit_plan_mode` immediately without
writing anything. The proxy handles all three; only the first two let the script
check what happens after a plan exists.

---

## Two commands nobody had tested

### `slashCommandInterceptor.test.ts`

21 tests on the eight commands the proxy answers before the model sees them.
Three failure shapes, none of them loud: a command that is *not* intercepted
reaches a local model as literal text and gets improvised at; a command that
*is* intercepted when it should not be steals `/copy` from the extension; and a
registry entry with no implementation, or no translation, lists itself in the
palette and then does nothing useful.

The last two are checked against the artefacts. Every proxy-handled entry in the
registry must produce something other than `passthrough`, and every entry's
`descriptionKey` must exist in the extension's own locale files — the registry is
served over `GET /commands` and rendered through `descriptionKey | translate`, so
the two packages have to agree. They did not: **`/brief` shipped with no
translation in either language**, showing a raw i18n key in the palette.

It also found a second one while being written: the interceptor read
`content[0].text`, so a command typed alongside an attachment — which Claudio can
now send — was invisible and went to the model as prose. The same "first block"
assumption that once pinned thinking to index 0. It reads the first *text* block
now.

The git-backed commands run against a real temporary repository, staged diff and
all, because each has a "nothing to show" branch that has to produce a sentence
rather than an empty enrichment — and because outside a repository they must
degrade to an answer instead of throwing.

### `workspaceTool.test.ts`

9 tests on `buildWorkspaceContextSummary()`, which on Path B is *everything* the
model knows about the workspace: the top-level listing, what `package.json` calls
the project, the start of the README.

Two of them are about what it does when it cannot look. An unreadable root
produced an **empty string**, injected into the prompt as nothing at all, leaving
the model to answer about a project it had never been shown — it now says it
could not list. And the listing is bounded: it goes into every system prompt of
the turn, so a directory with 500 entries used to spend the context window on
file names.

Reading it also turned up dead weight worth removing: a second
`WORKSPACE_TOOL_DEF` offering only `list` and `read`, and an
`executeWorkspaceTool()` implementing them over a fourth private copy of the
containment check. Nothing imported either. A stale duplicate of a schema is one
wrong import away from telling a model it has two actions when it has nine.

---

## The edit that said it had happened

Path B had twenty green tests and had never been run against a real model — the
loaded one carries 64 tools, so the textual loop never starts. Forced on with
`MAX_TOOLS=0`, read/write/bash/edit all worked and the files landed on disk. Then
this, asked in the plainest possible way:

> In `src/quoted.ts` replace the string `"hello world"` with `"ciao mondo"` —
> keep the double quotes.

The tag parser stops an attribute at the first double quote, which was already a
recorded limitation. What nobody had followed through is what it *produces*:
`old_string` arrived truncated to `const label = `, `new_string` truncated to the
same prefix, `edit` replaced a string with itself, wrote the file back byte for
byte, and answered **"Replaced 1 occurrence"**. The model then told the user the
change was done, quoting the new contents it had never written.

A write path that reports success while changing nothing is the worst shape a
failure takes in this project, and it needed a live model to surface: every unit
test passes a distinct `old_string` and `new_string`, because why would you write
one where they are equal?

Two changes, both small. `edit` refuses a replacement that cannot change
anything, and says why — including the quote limitation and the way around it.
And `TEXTUAL_TOOL_MANUAL` now teaches that limitation, so the model can avoid it
rather than discover it: asked again after the fix, it answered *"since the file
contains double quotes, I'll rewrite it entirely using `write`"*, and the file on
disk was correct.

**The drift test learned something too.** It joined the prompt files and the
manual before checking, so `python` — present in `agent-base.md`, missing from
Path B's manual — passed. A union proves only that *somewhere* says it. Each
artefact is now checked on its own, and the manual failed immediately.

---

## What the model actually does, measured

The third item on the list was a suspicion: during the live image runs the model
once answered with a tool call written as **plain text** —
`<tool_call><function=workspace>…` — which Path A does not parse, so the turn was
lost. The question was how often that happens, and whether the loop should learn
to read it.

**39 live calls later: never again.** 15 with a minimal system prompt, 12 with
the shipped one, 12 more in streaming mode, across prompt shapes chosen to
resemble the one that failed. Every single one used the native channel. One call
in 39 produced no tool call at all, which is a different thing and a legitimate
answer.

So no parser was written. The measurement is the deliverable, and it says the
imitation is rare enough that building for it would be building for a ghost.

What the measurement *did* find is two things worth more than the thing it was
looking for:

**The prompt had fallen behind the schema.** `python` is implemented, exposed in
the tool definition, and was named in no prompt at all — so a model reading its
instructions concludes the action does not exist. That is exactly what the one
failing turn said: *"there's no dedicated `python` action, but `bash` can execute
it"*, and then it improvised the textual call. `systemPromptBuilder.test.ts` now
derives the check from both artefacts: every action in `WORKSPACE_TOOL_DEF`'s
enum must appear in the shipped prompts. It failed on `python` the moment it was
written.

**The empty tool call has a cause, and it is not the model.** With
`max_tokens: 60` and a prompt that needs a longer call, the stream ends with
`finish_reason: "length"` and *zero* accumulated arguments — reproducible on
demand. The loop used to run `list .` in its place; it now says so and asks for
the call again, because the model had not asked for anything yet and a listing it
did not request is a puzzle, not an answer.

---

## A shell that does not stop the process

`bash` used to run under `spawnSync`, which blocks the Node.js event loop for as
long as the command takes — up to 30 seconds of nothing else happening: no SSE
writes to the client, no approval gate, no health probe. `grep` did the same for
up to 15, and `grep` is one of the read-only actions the agent loop dispatches
with `Promise.all`, so the parallelism it advertised was a queue.

Both spawn now, through one `runProcess()`. The interesting part of the change is
what `spawnSync` was doing for free:

| Was free | Now explicit | Covered by |
|---|---|---|
| Timeout | `spawn`'s `timeout` signals the child but leaves the promise pending, and a promise that never settles hangs the turn — so the kill is timed here | a `sleep 5` killed at 150 ms |
| `maxBuffer` | `spawn` has none; collection stops at a cap | the truncation notice only — the collection cap bounds memory and has no observable effect, so nothing asserts it |
| Exit code | arrives on `close`, and is `null` when a signal ended the process | the existing exit-code and no-output tests |

The property itself is asserted for `bash`, where it is observable: run
`sleep 0.4`, count the ticks of a 20 ms timer, and require at least five. Under
`spawnSync` that count is zero. `grep` shares the helper but has no such test —
a grep fast enough for a test is too fast to observe.

**And a control that lied.** Reverting grep's `exit 1 → "(no matches found)"`
came back green, which reads as missing coverage. It was not: the `perl`
substitution had the wrong indentation and never applied. Applied properly, it
fails exactly one test. Second time in this repo — when a control comes back
green, check the control first.

---

## Tool arguments the backend refuses

Found by running the thing, not by reading it — the first end-to-end image test
died one iteration in, with a raw HTML error page in the answer.

The model emitted a `workspace` call with **empty arguments**. Execution
tolerated that already (unparseable arguments fall back to `list .`), but the
loop replays its own history verbatim on the next iteration, and measured
against LM Studio an assistant `tool_calls` entry whose `arguments` is not a
JSON *object* string is rejected outright:

| `arguments` | Backend |
|---|---|
| `""` | 500 |
| `"   "` | 500 |
| `{"action":` (truncated) | 500 |
| `"null"` | 400 |
| `"{}"` | 200 |

So one malformed call killed the *next* turn, and the error the user saw came
from a machine two layers down. Arguments are now normalised where the assistant
turn is built — to the same fallback the executor uses, so the replay agrees
with the tool result beside it — and a replacement is logged, because a model
producing unusable calls is worth seeing even when the turn survives.

`"null"` deserved its own test: `JSON.parse` accepts it, so a guard that only
catches a throw lets it through, and reading `.action` off `null` then ends the
turn. It was live in three more places in the same file, all found by that one
test.

The fake had to be extended first. `Turn.calls` could only express arguments as
an object the fake serialised, so it could not produce the malformed string a
real model writes — a fake more forgiving than reality, again. It now takes a
raw `rawArgs` string.

---

## Where an action's image goes

### `actionOutcome.test.ts`

15 tests on the one question a `python` figure raises: where does the picture go?

Until now it went nowhere — its base64 *was* the tool-result string, so the model
paid tens of thousands of tokens for text it cannot read. The answer is decided
by the wire format rather than by preference:

- `role: "tool"` takes a **string**; an image part there is rejected.
- Every tool result of an assistant turn must follow that turn with nothing in
  between, so the image cannot even go straight after the result that produced
  it — Path A appends every tool result first, then one user message carrying
  the batch's images.
- Path B has no tool messages: its `<observation>` already is a user turn, so
  the image goes inside it, and the content stays a plain string when there is
  no image to carry.

A text-only model is told an image was produced and is not sent it. Both halves
matter: attaching to a text model is a rejected request, and saying nothing
leaves the model describing a picture it never received.

The figure is also **written into the workspace**, and the notice names the path
for both kinds of model — the attached image is what the model sees, the file is
the only handle the user has on it. `workspaceActions.test.ts` covers the write:
that two figures in the same second do not overwrite each other (the model
draws, looks, redraws — the ordinary case), that a plot directory pointing
outside the workspace is refused like any other write, and that a save which
fails says so and still hands the model its image.

One of those tests taught its own lesson. It first wrote its escape target to a
fixed name beside the temp workspace, which is *shared*: the negative-control
run — the one that removes the containment check on purpose — left a real
directory there, and every later run tripped over it. A test that reintroduces a
bug on purpose has to clean up after the bug.

Two of the 13 read the **shipped source** instead of a fake, because the failure
they guard is the one this project keeps meeting — a helper that is correct,
tested, and called by nobody. One asserts neither loop pushes a `role: "tool"`
message of its own; the other asserts both call sites resolve vision capability
from the loaded model. A `visionCapable` that is never wired type-checks
perfectly and quietly attaches nothing.

---

## An image counted as prose

`estimateTokens()` scores a conversation at 4 characters per token. That is right
for prose and wrong for base64 by about two orders of magnitude: a 500 KB
screenshot is roughly 683 000 characters of payload, which the rule reports as
~171 000 tokens — more than the entire loaded window, for one attachment a vision
model charges a few hundred tokens for.

The consequence is not a rejected request, which is why nothing surfaced it. It
is that **attaching a picture silently discards the conversation**: the estimate
clears the 80 % threshold on its own, compaction runs, and `naive` keeps the
first message and the last two — so the image survives and the history around it
does not. With semantic compaction enabled it is worse than that, because the
summarisation prompt embeds the history verbatim, so the payload was also being
sent to a text model to be summarised.

Images are now charged a flat `IMAGE_TOKEN_COST` in place of their payload, in
both message shapes — `source.data` on an Anthropic block, and the `data:` URI
in `image_url.url` after translation — since compaction runs on both sides of it.
The summariser is handed the same payload-free serialisation.

This is the half of the image path that could be tested without a GPU. The other
half — whether the model actually *sees* the picture — needs LM Studio with a VLM
loaded, and no suite here can stand in for it.

---

## Trimming that breaks the conversation

Compaction removes messages by position. That is fine for prose and wrong for
this proxy, where a long conversation is mostly `tool_use` / `tool_result` pairs.
After translation those become an assistant turn carrying `tool_calls` and the
`tool` messages answering it, and an OpenAI-compatible backend rejects the whole
request when either half has lost its partner:

- a result with no preceding call is a `tool` message answering nothing;
- a call with no result is one the backend is still waiting on.

Either way the user gets a 400 instead of a reply, and only ever in a long
session — which is to say the one where losing the turn costs most. `repairToolPairing()`
runs after every trim, drops whichever half was orphaned, and keeps any text that
shared the message with it.

---

## Two grammars that had drifted apart

`TEXTUAL_TOOL_MANUAL` is the model's entire instruction set for Path B. Every
example in it is a promise, and two of them were not kept.

**`edit` could not work at all.** The manual teaches

```xml
<action name="edit" path="src/foo.ts" old_string="const x = 1" new_string="const x = 2"/>
```

but `parseActionTag` only ever read `name`, `path`, `pattern`, `include` and
`cmd`. A model following that example to the letter produced an action with
neither string, so `executeAction` answered `Error: 'old_string' is required` —
every time, for every edit, on every model without native tool calls.

**`write` in the documented form was shown to the user instead of run.** The
manual teaches a body form:

```xml
<action name="write" path="hello.txt">
hi
</action>
```

The parser looked only for `/>`, which that tag never contains. It stayed in tag
mode, buffered to the end of the stream, and the remainder flush emitted the
whole thing to the client as prose. No file, no error, and a model told nothing
at all.

The tag scan is now quote-aware as well, so a `>` inside an attribute
(`cmd="ls > out"`) no longer risks ending the tag early.

A third overstatement, of a different kind: `MAX_ITERATIONS = 10` was hardcoded
here while the 1.3.0 changelog announced that `MAX_AGENT_ITERATIONS` "replaces
the hardcoded limit of 10". It replaced it in Path A only. The direction of the
error matters — on a small context window the adaptive tier resolves *below* ten,
so the hardcoded value meant ten rounds of observations into a window sized for
fewer. Path B now receives the same resolved ceiling Path A does.

And one claim in the other direction, worth recording because it was written down
as a gap and was not one: Path B was said to be missing parallel dispatch of
read-only actions. It is not missing, it does not apply — the parser stops at the
first complete tag and discards the rest of the turn, exactly as the manual tells
the model to behave, so a second action never exists. A test pins that the parser
and the manual agree on it.

Path B is a fallback and documented as second-class, which is presumably why
this survived: on a model with native tool calls it never runs. That is also
what made it invisible.

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
| Pass `new_string` to `replace()` directly | Dollar-sign test fails | exactly 1 fails |
| Skip `resolve()` on the workspace root | Trailing-slash test fails | exactly 1 fails |
| Drop the separator from `safeResolvePath` | Sibling-prefix test fails | exactly 1 fails |
| Remove `old_string`/`new_string` from the parser | Edit and grammar tests fail | exactly 2 fail |
| Stop accepting the body tag form | Manual-form write test fails | exactly 1 fails |
| Ignore the caller's iteration ceiling in Path B | Configured-limit test fails | exactly 1 fails |
| Never return `"fallthrough"` | Fallthrough tests fail | exactly 2 fail |
| Drop the assistant tool_calls turn from the replay | Replay test fails | exactly 1 fails |
| Run destructive calls in parallel | Overlap test fails | exactly 1 fails |
| Disable `repairToolPairing` | Pairing tests fail | exactly 5 fail |
| Skip compaction between loop iterations | Mid-turn growth test fails | exactly 1 fails per loop |
| Measure image payloads as prose again | Estimator and screenshot tests fail | exactly 2 fail |
| Embed the payload in the summary prompt | Summariser payload test fails | exactly 1 fails |
| Attach each image right after its own tool result | Ordering tests fail | exactly 2 fail |
| Return the payload as result text again | Every notice and payload test fails | exactly 5 fail |
| Attach images to a text-only model too | Text-only test fails | exactly 1 fails |
| Never carry an image in a Path B observation | Path B image test fails | exactly 1 fails |
| Shape tool results inside the loop again | Wiring test fails | exactly 1 fails |
| Drop the `vlm` resolution in `server.ts` | Vision-wiring test fails | exactly 1 fails |
| One plot name per second, overwriting | Second-figure test fails | exactly 1 fails |
| Skip containment on the plot directory | Escape test fails | exactly 1 fails |
| Swallow the save failure | Save-failure test fails | exactly 1 fails |
| Leave the saved path out of the notice | Both path tests fail | exactly 2 fail |
| Replay tool arguments verbatim again | Malformed-argument tests fail | exactly 3 fail |
| Accept anything `JSON.parse` accepts | Null-arguments test fails | exactly 1 fails |
| Route to Path A whatever `maxTools` says | Path B test fails | exactly 1 fails |
| Treat `"fallthrough"` as `"handled"` | Fallthrough test fails | exactly 1 fails |
| Inject the agent prompt without a workspace | CLI system-prompt test fails | exactly 1 fails |
| Remove the capability guard | Guard test fails | exactly 1 fails |
| Guess a context budget when metadata is missing | Zero-budget test fails | exactly 1 fails |
| Pass status 0 through as an HTTP status | Connection-refused test fails | exactly 1 fails |
| Run bash under `spawnSync` again | Event-loop test fails | exactly 1 fails |
| Time out without killing the child | Timeout test fails | exactly 1 fails, after waiting the full 5 s |
| Treat grep's exit 1 as an error | No-matches test fails | exactly 1 fails |
| Drop `python` from the shipped prompt | Schema-vs-prompt test fails | exactly 1 fails |
| Run `list .` for a truncated call again | Truncated-call tests fail | exactly 2 fail |
| Replay the raw arguments again | Replay tests fail | exactly 3 fail |
| Let an edit replace a string with itself | No-op edit test fails | exactly 1 fails |
| Drop `python` from `TEXTUAL_TOOL_MANUAL` | Schema-vs-instructions test fails | exactly 1 fails |
| Swallow an unfinished action tag | Unfinished-tag tests fail | exactly 2 fail |
| Read only the first content block again | Attachment-command test fails | exactly 1 fails |
| Stop blocking Anthropic-only commands | `/login` test fails | exactly 1 fails |
| Drop the registry guard *and* `execute()`'s default | Passthrough tests fail | exactly 2 fail (see below) |
| Swallow an unreadable workspace again | Empty-summary test fails | exactly 1 fails |
| Contain the plan path with `startsWith` again | Sibling-prefix test fails | exactly 1 fails |
| Skip block-array messages when injecting a plan | Attachment tests fail | exactly 2 fail |
| Prepend the plan with no instruction | Preamble test fails | exactly 1 fails |
| Read a cached `maxTools` by truthiness | Cached-zero test fails | exactly 1 fails |
| Read the cached thinking flags by truthiness | Cached-false and partial-cache tests fail | exactly 2 fail |
| Make `merge` replace instead of merge | Write-back tests fail | exactly 3 fail |
| Run the second thinking probe unconditionally | No-reasoning test fails | exactly 1 fails |
| Signal the pid instead of the process group | Grandchild test fails | exactly 1 fails |
| Poll health for a process known to be dead | Give-up test fails | exactly 1 fails, after the full 30 s |
| One PID file for every workspace | Per-directory test fails | exactly 1 fails |
| Let a contentless `todo` empty the list | No-content test fails | exactly 1 fails |
| Drop containment on the configured todo path | Escape test fails | exactly 1 fails |
| Inject an empty todo section | Empty-section test fails | exactly 1 fails — after three tests were added for it |
| List every top-level entry again | Listing-cap test fails | exactly 1 fails |

A test suite that has never been seen to fail is decoration. Anything added here
should come with the same check.

### When the control does not fail

Two more the same day, and both were the *edit* rather than the test: `perl -0pi`
substitutions that silently matched nothing, once because of an escaped
backslash and once because of an em dash in the pattern. Re-applied with a script
that asserts the pattern was found, both controls failed as expected. If a
control comes back green, print the file before believing it.

A third instance, 2026-08-27: removing the registry guard from the slash
interceptor changed nothing, because `execute()`'s `default:` returns
`passthrough` as well. The substitution *had* applied — it was checked this time
— and the tests were right to stay green: two guards, one removed. Removing both
fails exactly two tests. A control has to break every site that enforces the
property, or it proves nothing about the test.

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

Everything on the Phase 1 priority list is covered, plus both agent loops, the
workspace actions and the compactor. **That is not the same as "everything".**
Counted honestly, these have no suite:

| Uncovered | Why it matters, or does not |
|---|---|
| `modelInfo`, `thinkingProbe` | Reading LM Studio's metadata, and the thinking probe itself. Their *orchestration* — the detectors and the cache under them — is covered |
| `i18nLoader`, `pythonExecutor` | Infrastructure with real I/O |
| The adapters (`fetchLlmClient`, `nodeSseWriter`, `fsPromptRepository`, `fsPlanFileRepository`, `sseApprovalInteractor`) | Thin by design; the ports they implement are exercised through fakes everywhere else |
| `server.ts`, `main.ts` | Wiring and composition |

Beyond those, what is left is not a component but a set of *decisions*, recorded
in [PLAN.md](../../PLAN.md) rather than left as silent gaps:

- `tool_choice: "any"` maps to `auto`, losing Anthropic's "you must call some
  tool". A test pins the current behaviour and points here.
- A stream truncated without `[DONE]` emits `message_start`, opens a block and
  then closes with no `content_block_stop`, `message_delta` or `message_stop`.
- Path B's `edit` grammar cannot express an `old_string` containing a double
  quote, because attributes are parsed with `[^"]*` and the manual teaches no
  escaping.

The remaining risk is not in any one unit but between them — which is what
`scripts/regression.sh` is for, and why it still earns its place.

Two behaviours are known-uncovered on purpose, both recorded in
[PLAN.md](../../PLAN.md) as decisions rather than gaps: the `tool_choice: "any"`
mapping, and what a stream that ends without `[DONE]` should send.

---

## The two surfaces, checked by hand

Neither of these can run in CI, and both answer a question no suite can.

`scripts/cli-e2e.sh` is the **CLI** surface — the half where the proxy is a pure
translator and Claude Code keeps its own loop, its own tools and its own prompts.
Two turns: a plain answer, which exercises translation, streaming and the
`max_tokens` cap (32 000 → 29 888 on this model), and a turn using the CLI's own
`Read` tool, which exercises the `tool_use` / `tool_result` round trip. That
second one is the reason the script exists: a mistranslated tool result does not
throw, it produces a confident answer about the wrong thing.

Run 2026-08-27 for the first time in this repo's life: both turns as expected.
Worth noting what it showed — Claude Code sent **3 tools**, not the ~40 the docs
have always assumed; that number belongs to an interactive session, not to
`--print`.

`chat-extension/scripts/approval-e2e.ts` and `plan-mode-e2e.ts` are the same idea
for the **Claudio** surface: the approval handshake and the plan-mode round trip,
driven through the shipped client with only the human click simulated.

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
