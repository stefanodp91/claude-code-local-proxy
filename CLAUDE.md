# CLAUDE.md

Orientation for an agent picking this repository up cold. Written in English to
match the rest of the docs; [PLAN.md](PLAN.md), the state-and-roadmap document,
is in Italian.

---

## What this is

Three things in one repo, and only one of them is live work:

| Path | What | Status |
|---|---|---|
| [`proxy/`](proxy/) | Anthropic → OpenAI translation proxy, ~7 800 lines TS | **The project.** Everything below is about this |
| [`chat-extension/`](chat-extension/) | "Claudio", a VS Code chat extension | Active, smaller |
| [`claude_code/src/`](claude_code/src/) | Leaked Claude Code CLI source (2026-03-31), 1 902 files | Reference archive. **Never modified, never imported** |

The proxy serves two surfaces, and the difference decides almost everything:

```
Claudio  ──[X-Workspace-Root]──>  proxy  runs its OWN agent loop
                                         (workspace tool, approval gate,
                                          plan mode, python executor)

CLI      ──[no header]─────────>  proxy  is a pure translator
                                         (the CLI keeps its own loop and tools)
```

The routing lives in `handleChatMessageUseCase.ts`, inside `if (workspaceCwd)`.
Roughly 3 000 of the proxy's 7 800 lines exist only for Claudio.

---

## Verify anything with these

```bash
cd proxy && npm test         # 275 tests, ~390 ms
cd proxy && npm run typecheck
cd chat-extension && npm run typecheck
```

No GPU, no LM Studio, no model loaded, no network. That is deliberate: it is what
lets these gate a pull request. [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
runs exactly these on every push and PR.

`proxy/scripts/regression.sh` is a different tool — a curl snapshot needing a
live backend and a loaded model. It answers "does *this model* still behave like
last week", not "is the code correct". Useful before a release, never a gate.
Do not conflate the two; the project already did once.

---

## Invariants — do not break these without saying so

- **`proxy/dependencies` is `{}` and stays that way.** Node built-ins only at
  runtime. It is why deployment is a file copy and why tests need no mock
  framework. The four devDependencies never reach a running process.
- **The i18n map is flat.** `t()` returns the key itself on a miss and locale
  files come through `JSON.parse`, so a nested key type-checks perfectly and
  reaches the user as the raw string `some.key`. `test/i18n.test.ts` guards it.
- **Layering points one way**: `domain` → nothing, `application` → domain +
  ports, `infrastructure` → both. Honoured completely in `domain/`. Three known
  exceptions in `application/` predate the refactor and are listed in
  [`proxy/README.md`](proxy/README.md#file-structure) — add to that list rather
  than to the silence.
- **`safeResolvePath()` in `workspaceActions.ts` is the containment boundary.**
  Two other places had a weaker copy of that check and both were wrong. If you
  need containment, use `relative()` — never `startsWith(root)`.
- **Docs describe the code as it is.** When they disagree, the code wins, but the
  drift gets fixed rather than ignored. This repo shipped for months with a
  README describing a Bun server that had not existed for releases.

---

## How work is done here

**The failure mode of this project is the silent one.** Eleven bugs have been
found by the test suites and not one threw, logged, or failed a typecheck: a
probe reading timeouts as capability, an allowlist rule approving the opposite of
what it said, an `edit` corrupting `$` in replacements, a tool manual teaching a
grammar the parser refused, compaction producing a conversation the backend
rejects. Useful work here is usually *making noisy what is currently quiet*.

**Test first, then fix.** Write the test asserting the behaviour you believe is
correct, watch it fail, then change the code. The suites in `proxy/test/` were
all built that way and it is what turned up the nine.

**Every test gets a negative control.** Reintroduce the bug on purpose and
confirm the test fails — and fails *narrowly*. A suite nobody has seen fail is
decoration. The observed counts are tabulated in
[`proxy/docs/testing.md`](proxy/docs/testing.md#negative-control).

Three traps, all hit on this branch, all invisible in a green run:

- **A test that cannot fail.** Four ToolManager tests used a limit of 7 against
  exactly 7 tools, so the code returned early and filtered nothing; the
  assertions passed while verifying nothing. Guard the precondition explicitly
  when a test depends on one — `assert(useToolDef !== null)` before asserting
  anything about the filtering.
- **A control that comes back green.** It may mean the test is weak *or* that
  the control never introduced the bug. Reverting a two-site fix at one site
  leaves both sites guarding; `(b.score - a.score) || 1` does not reorder
  anything in V8. Verify the control before touching the test.
- **A fake more forgiving than reality.** The prompt-builder tests use a
  repository that echoes its parameters, so they passed while the shipped
  `agent-base.md` had no `{{memorySection}}` and the whole feature did nothing.
  Where a fake stands in for a *file on disk*, one test has to read the real
  file. The same shape caught the Path B grammar bugs: a test comparing against
  a list written in the test proves only that the list matches itself.

**Fakes are object literals.** `LlmClientPort`, `SseWriterPort` and the rest are
already ports; `proxy/test/fakes.ts` holds the shared ones. A fake that drifts
out of shape fails `tsc` because `tsconfig.json` includes `test/`.

**Prefer deriving a test's expectations from the code or the artefact under
test** rather than from a list you wrote. Two suites now do this and both caught
real drift: `textualAgentLoop.test.ts` asks `parseActionTag` about every
attribute `TEXTUAL_TOOL_MANUAL` teaches, and `systemPromptBuilder.test.ts` reads
`prompts/en_US/*.md` to check every parameter the builder passes is actually
interpolated somewhere.

---

## Where the state lives

| Document | Holds |
|---|---|
| [PLAN.md](PLAN.md) | **Start here.** Phases, what was measured on the current model, what is done, what is next, and the open decisions. Italian |
| [proxy/docs/testing.md](proxy/docs/testing.md) | What each suite pins, every bug the suites found, the negative-control results |
| [proxy/docs/](proxy/docs/) | Architecture, configuration, agent loop, permission protocol, tool management, lifecycle |
| [proxy/CHANGELOG.md](proxy/CHANGELOG.md) / [chat-extension/CHANGELOG.md](chat-extension/CHANGELOG.md) | Per-component detail. **Add entries here, not to the root CHANGELOG**, which is an index |

Numbers that appear in more than one document — test counts, versions — are kept
in step by hand. If you change one, grep for the others.

---

## Conventions

- Work on a branch; `main` is the default target. Current branch:
  `fase-0-cleanup`, open as PR #1.
- Conventional commits (`fix(proxy):`, `test(proxy):`, `docs:`). Commit messages
  here carry the *reasoning* — what was wrong, why it survived, how it was
  verified — because that is the part no diff shows.
- Every relative link and `#Lnnn` anchor in the markdown is expected to resolve.
  There is no linter for it; check before committing.
- Measure, do not extrapolate. Model capabilities do not transfer between
  models, and backend-declared metadata is unreliable. The probe is the
  authority.

---

## Current state, and what is next

Phase 1 (the safety net) is **closed** and Phase 2 is done bar one item
deliberately left alone. 275 tests on every push.

"Every component has a suite" would be an overstatement, and was made once in
this repo's own docs before being counted: the routing use case, the slash
interceptor, startup probing and the thin adapters have no tests. [`proxy/docs/testing.md`](proxy/docs/testing.md#not-covered-yet)
enumerates them.

**Phase 3 is under way.** Cross-session memory is done: `.claudio/MEMORY.md` is
prepended to the system prompt when present, and the model updates it through
the ordinary gated `write` rather than a dedicated path.

**In progress, from PLAN.md §6: the image path.** The translation was already
covered by tests; what was not covered was every other place an image passes
through. Two silent problems came out of looking:

- **Fixed** — `estimateTokens()` counted base64 as prose, so a 500 KB screenshot
  scored ~171 000 tokens and compaction fired on a conversation that fit. `naive`
  keeps the first message and the last two, so the image survived and the history
  did not: attaching a picture reset the conversation, with no error anywhere.
  Images now cost a flat nominal amount in both message shapes.
- **Fixed** — a `python` action that drew a plot returned the PNG's base64 *as
  the tool result string*. `executeAction` now returns an `ActionOutcome` (`text`
  plus an optional `image`) and the loops hand that image to the model as an
  image part, through [`services/actionOutcome.ts`](proxy/src/application/services/actionOutcome.ts).
  Where it can go is a wire-format constraint, not a preference: `role: "tool"`
  takes a string, and nothing may sit between an assistant turn and its tool
  results — so Path A appends all results first, then one user message with the
  batch's images. Attached only when the model reports `type: "vlm"`.

The end-to-end leg — does the model actually see the picture — is still the one
thing the suites cannot do: it needs LM Studio with a VLM loaded. Cover what you
can in tests, then say plainly that the rest needs a human with a GPU.

**Phase 2 — known correctness**, from PLAN.md §5:

1. ~~Compaction absent inside the agent loop~~ — **done**. It now runs between
   iterations in both loops, through `services/contextCompactor.ts`. Extracting
   it surfaced a second problem: trimming by position cuts through `tool_use` /
   `tool_result` pairs, and an orphan on either side makes the backend reject the
   request — in long conversations only, which is to say exactly when compaction
   runs. `repairToolPairing()` handles both message shapes.
2. ~~Path B lies about its own limits~~ — **done**. It now receives the same
   resolved iteration ceiling Path A uses. The other half of that item was
   wrong: parallel read-only dispatch is not *missing* from Path B, it does not
   *apply* — the parser stops at the first complete tag, so there is never a
   second action to dispatch.
3. **`bash` blocks the event loop**  ← **next** for up to 30s (`spawnSync`). Acceptable for
   a local single-user proxy — know it, do not fix it now.

Three **decisions**, not gaps, also recorded in PLAN.md §5: the
`tool_choice: "any"` mapping, what a stream truncated without `[DONE]` should
send, and Path B's inability to express a quote inside `old_string`. Each has a
test pinning today's behaviour and pointing at the note.
