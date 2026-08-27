# CLAUDE.md

Orientation for an agent picking this repository up cold. Written in English to
match the rest of the docs; [PLAN.md](PLAN.md), the state-and-roadmap document,
is in Italian.

---

## What this is

Three things in one repo, and only one of them is live work:

| Path | What | Status |
|---|---|---|
| [`proxy/`](proxy/) | Anthropic → OpenAI translation proxy, 8 816 lines TS in 50 files, plus 5 303 lines of tests | **The project.** Everything below is about this |
| [`chat-extension/`](chat-extension/) | "Claudio", a VS Code chat extension — 63 tests since 2026-08-27 | Active, smaller |
| [`claude_code/src/`](claude_code/src/) | Leaked Claude Code CLI source (2026-03-31), 1 902 files | Reference archive. **Never modified, never imported** |

The proxy serves two surfaces, and the difference decides almost everything:

```
Claudio  ──[X-Workspace-Root]──>  proxy  runs its OWN agent loop
                                         (workspace tool, approval gate,
                                          plan mode, python executor)

CLI      ──[no header]─────────>  proxy  is a pure translator
                                         (the CLI keeps its own loop and tools)
```

Both were verified against a live model on 2026-08-27 —
`proxy/scripts/cli-e2e.sh` for the CLI, `chat-extension/scripts/*-e2e.ts` for
Claudio. One correction from that: Claude Code sends **3** tools in `--print`
mode, not the ~40 this repo's docs had always assumed; the large number belongs
to an interactive session.

The routing lives in `handleChatMessageUseCase.ts`, inside `if (workspaceCwd)`.
Roughly 3 570 of the proxy's 8 816 lines exist only for Claudio — the two agent
loops, the workspace actions, the approval gate, the prompt builder and the
repositories behind them. Counted, not estimated; recount when it matters.

---

## Verify anything with these

```bash
cd proxy && npm test         # 446 tests, ~15 s
cd proxy && npm run typecheck
cd chat-extension && npm test          # 63 tests: 52 host + 11 webview
cd chat-extension && npm run typecheck
```

No GPU, no LM Studio, no model loaded, no network. That is deliberate: it is what
lets these run anywhere, on any commit, in under a second.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs exactly these — but
**only when asked**, never once per commit:

```bash
gh workflow run ci.yml --ref <branch>
```

(A commit-message marker was tried and removed the same hour: the commit
introducing it described it, so it triggered the run it existed to withhold.)

Nothing automatic therefore stands between a broken commit and `main`. **The
gate is the two commands above, run locally before committing** — mandatory, not
a convenience the pipeline will repeat for you.

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
- **A `tool_calls` entry's `arguments` must be the string of a JSON object.**
  Measured against LM Studio: `""`, whitespace and truncated JSON all give 500,
  `"null"` gives 400, `"{}"` gives 200. The loop replays its own history, so one
  malformed call — which is what a call truncated by `max_tokens` looks like —
  used to kill the *next* request. Normalise where the assistant turn is built.
- **The intelligence lives in the proxy.** Claudio and the CLI are surfaces:
  they render, they collect clicks, they own an editor. Every rule — what may be
  done to a workspace, when a human is asked, what the model is told, when a
  context is trimmed, how the proxy's own lifecycle is managed — belongs in the
  proxy, once. Where a rule is written twice, the second copy is a bug waiting
  to be found separately: `ProxyManager` and `start_agent_cli.sh` both killed a
  proxy by the wrapper's pid, and the same orphaned process was fixed in one and
  not the other for as long as they were two.
- **Docs describe the code as it is.** When they disagree, the code wins, but the
  drift gets fixed rather than ignored. This repo shipped for months with a
  README describing a Bun server that had not existed for releases.

---

## How work is done here

**The failure mode of this project is the silent one.** Every bug found here so
far — the full list is in [`proxy/docs/testing.md`](proxy/docs/testing.md) — was
one that threw nothing, logged nothing and passed the typecheck: a probe reading
timeouts as capability, an allowlist rule approving the opposite of what it said,
an `edit` corrupting `$` in replacements, a tool manual teaching a grammar the
parser refused, compaction producing a conversation the backend rejects, a
screenshot silently resetting the conversation. Useful work here is usually
*making noisy what is currently quiet*.

**Test first, then fix.** Write the test asserting the behaviour you believe is
correct, watch it fail, then change the code. Every suite in `proxy/test/` was
built that way, and that is what turned up most of the list.

**Then run it.** The suites cannot see what only a live model shows. Trying the
image path end to end — with LM Studio loaded, through the real proxy — found
three more in an afternoon, one of which had nothing to do with images. Forcing
Path B on with `MAX_TOOLS=0` found a fourth on its first real request: an `edit`
that replaced a string with itself, reported "Replaced 1 occurrence", and had the
model tell the user about a change that never happened. Twenty green tests had
never produced one, because nobody writes an `edit` test where `old_string` and
`new_string` are equal. If a feature has never been exercised against a real
backend, "the tests pass" is a statement about the tests.

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
  anything in V8; and a `perl -0pi` substitution with the wrong indentation
  edits nothing at all while looking like it did. Verify the control before
  touching the test.
- **A fake more forgiving than reality.** The prompt-builder tests use a
  repository that echoes its parameters, so they passed while the shipped
  `agent-base.md` had no `{{memorySection}}` and the whole feature did nothing.
  Where a fake stands in for a *file on disk*, one test has to read the real
  file. The same shape caught the Path B grammar bugs: a test comparing against
  a list written in the test proves only that the list matches itself. And again
  on 2026-08-27 — the shipped prompt named neither `python` nor anything about
  it, while the tool schema offered it, so the model was being told an
  implemented action did not exist. The test that catches that reads *both*
  artefacts and compares them to each other.

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

**Everything on the roadmap is closed except one item that is waiting on a
decision, not on work.** Phases 0, 1 and 2 are done; Phase 3 is done through its
third item. 446 tests, ~15 s, run locally before every commit — CI runs only
when asked (`gh workflow run ci.yml --ref main`), so nothing automatic stands
between a broken commit and `main`.

| | State |
|---|---|
| Phase 0 — cleanup, probe, guard | closed |
| Phase 1 — the safety net | closed, 0 → 446 tests |
| Phase 2 — known correctness | closed: compaction inside both loops, Path B's real iteration ceiling, `bash`/`grep` off the event loop |
| Phase 3.1 — cross-session memory | done |
| Phase 3.2 — the image path | done, and **verified live** against `qwen/qwen3.8-27b` |
| Phase 3.3 — textual tool calls | measured: a ghost, no parser written |
| Phase 3.4 — parity with Claude Code | decided 2026-08-27: TodoWrite + Skills, then Hooks, then MCP — all inside the proxy loop, so all for Claudio. See PLAN.md §7 |

"Every component has a suite" was once written here and was false when counted.
It is closer now — the routing use case, the slash interceptor and the workspace
summary all have one — but startup probing, the thin adapters and the wiring
still do not, and [`proxy/docs/testing.md`](proxy/docs/testing.md#not-covered-yet)
keeps the honest list.

**Where to pick up.** Claudio has 63 tests since 2026-08-27 — the SSE parser,
the proxy client, the approval bridge, and the webview's streaming assembly —
plus `chat-extension/scripts/approval-e2e.ts`, which drives the real handshake
against a running proxy the way `regression.sh` does for the proxy. No Angular
template is rendered by any of it, deliberately: that needs a second runner.

In the proxy the component list is now down to startup probing, the
thin adapters and the wiring — worth less than it looks, because it is either
composition or I/O a test would end up simulating. The least useless of them is
the probe orchestration (`toolLimitDetector`), where a cache read wrongly costs
a model most of its tools. Beyond that: re-measure whenever the model changes —
the numbers in PLAN.md §2 belong to *that* model, and the probe is the
authority.

**What the last session actually found**, because it is the pattern worth
repeating rather than the details worth memorising: the cheapest item on the list
— "just try the image path, it may already work" — turned up three bugs, and only
one of them was about images. An attached screenshot silently reset the
conversation (base64 counted as prose by the token estimator). A `python` figure
came back to the model as base64 text. A tool call truncated by `max_tokens`
arrives with no arguments, and replaying it verbatim made the backend refuse the
*next* request with a 500. All three were invisible: no exception, no log, no
failing typecheck.

PLAN.md §9 is the resume-from-cold section — what is true today, what needs no
decision, and the traps this repo has already paid for. The full detail of every
change is in [`proxy/CHANGELOG.md`](proxy/CHANGELOG.md).
