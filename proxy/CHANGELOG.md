# Proxy Changelog

All notable changes to the Anthropic-to-OpenAI proxy are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] — 2026-08-27

> **In one paragraph, for whoever reads this cold.** Everything below landed in
> one long session. Cross-session memory shipped first; then the image path was
> taken end to end, which meant fixing an estimator that counted base64 as prose
> (an attached screenshot silently reset the conversation), giving a `python`
> figure a way to reach the model as an image and the user as a file, and — once
> it was actually run against a loaded model — discovering that a tool call
> truncated by `max_tokens` made the backend refuse the *next* request. The
> routing use case got its first suite, `bash` and `grep` stopped blocking the
> event loop, and CI stopped running on every commit. Test count over the
> session: 257 → 315.

### Added — The last two uncovered components, and what covering them found

- **`slashCommandInterceptor` (21 tests).** The eight commands the proxy answers
  before the model sees them. Two of the checks are derived from the artefacts:
  every proxy-handled registry entry must do something, and every entry's
  `descriptionKey` must exist in the extension's locale files, since the registry
  is served over `GET /commands` and rendered through `descriptionKey |
  translate`.

- **Two bugs, both silent.** `/brief` shipped with **no translation in either
  language**, so Claudio's palette showed the raw key `slash.commands.brief`. And
  the interceptor read `content[0].text`, so a command typed alongside an
  attachment — which Claudio can now send — was invisible and went to the model
  as prose. It reads the first *text* block now; the same "first block"
  assumption that once pinned thinking to index 0.

- **`workspaceTool` (9 tests).** `buildWorkspaceContextSummary()` is everything
  the model knows about the workspace on Path B. An unreadable root produced an
  **empty string**, injected into the prompt as nothing at all — it now says it
  could not list. And the top-level listing is capped at 60 entries with a note:
  it goes into every system prompt of the turn, and a directory with 500 entries
  spent the context window on file names.

- **Dead weight removed** from `workspaceTool.ts`: a second `WORKSPACE_TOOL_DEF`
  offering only `list` and `read`, and an `executeWorkspaceTool()` implementing
  them over a fourth private copy of the containment check. Nothing imported
  either — the real schema has nine actions — and a stale duplicate of a schema
  is one wrong import away from being believed.

- `npm test` is now 348 in ~1.0 s. `docs/testing.md`'s "not covered yet" list
  loses its last two component rows. Negative control on six fronts, plus a
  seventh that could not fail: removing the interceptor's registry guard changes
  nothing because `execute()`'s `default:` returns passthrough too — two guards,
  and both have to go for the tests to notice.

### Fixed — An `edit` that changed nothing reported success

Found by running Path B against a real model for the first time. It had twenty
green tests and no live run — the loaded model carries 64 tools, so the textual
loop never starts unless it is forced with `MAX_TOOLS=0`.

- **The failure.** Asked to replace `"hello world"` with `"ciao mondo"`, the model
  emitted an `edit` whose attributes stopped at the first double quote — a
  recorded limitation of the tag grammar. What nobody had followed through is
  what it produces: `old_string` and `new_string` both truncated to the same
  prefix, `edit` replacing a string with itself, the file written back byte for
  byte, and the action answering **"Replaced 1 occurrence"**. The model then told
  the user the change was done and quoted contents it had never written.

- `edit` now refuses a replacement that cannot change anything and says why,
  including the quote limitation and the way around it. No unit test had caught
  it because every one of them passes a distinct `old_string` and `new_string`.

- **`TEXTUAL_TOOL_MANUAL` now teaches the limitation**, so the model can avoid it
  instead of discovering it. Asked again after the fix: *"since the file contains
  double quotes, I'll rewrite it entirely using `write`"* — and the file on disk
  was right. It also teaches `python`, which it had never mentioned.

- **The drift test was weaker than it looked.** It joined the prompt files and
  the manual before checking, so `python` passed on the strength of
  `agent-base.md` alone while Path B's manual still lacked it. Each artefact is
  checked separately now, and the manual failed at once.

- An unfinished action tag reaching the user as text is pinned as a decision
  rather than left to drift: showing it is deliberate, since the alternative is
  silently dropping what the model was in the middle of saying.

- 4 tests; `npm test` is now 318. Negative control: allowing the no-op edit fails
  exactly 1, dropping `python` from the manual fails exactly 1, swallowing an
  unfinished tag fails exactly 2.

### Fixed — The prompt never mentioned `python`, and a cut-off call ran the wrong action

Both found by measuring how often the model writes tool calls as plain text
instead of using the native channel. The answer to *that* question is **never**,
in 39 live calls across three configurations — so no parser was built for it.
The two findings underneath were worth more.

- **`python` was named in no prompt.** It is implemented, exposed in the tool
  schema, and the model was being told the available actions are list, read,
  grep, glob, write, edit and bash. A model that reads its instructions then
  concludes the action does not exist — which one did, in the wild: *"there's no
  dedicated `python` action, but `bash` can execute it"*, followed by a tool call
  written as text. `agent-base.md` now names it, with what the venv provides and
  what `plt.show()` gives back.

- **A test derived from both artefacts**, so this cannot drift again: every
  action in `WORKSPACE_TOOL_DEF`'s enum must appear in the shipped prompts. It
  failed on `python` the moment it was written.

- **An empty tool call is a truncated one.** Measured: `max_tokens: 60` on a
  prompt needing a longer call ends the stream with `finish_reason: "length"` and
  zero accumulated arguments, on demand. The loop ran `list .` in its place —
  harmless, and a puzzle for a model that had asked for nothing. It now returns a
  sentence saying the call was cut short and asking for it again, executes
  nothing, never raises an approval modal, and replays `{}` so the backend still
  accepts the history.

- 4 tests; `npm test` is now 315. Negative control: removing `python` from the
  prompt fails exactly 1, running `list .` again fails exactly 2, replaying raw
  arguments fails exactly 3.

### Changed — `bash` and `grep` no longer stop the process

- `spawnSync` blocked the Node.js event loop for as long as the command ran: up
  to 30 s for `bash`, 15 s for `grep`, during which nothing else happened — no
  SSE writes to the client, no approval gate, no health probe. `grep` is one of
  the read-only actions the agent loop dispatches with `Promise.all`, so that
  parallelism was a queue.

- Both now go through one async `runProcess()`. What `spawnSync` did for free is
  explicit, and each piece has a test because losing one is silent:

  - **the timeout must kill.** `spawn`'s own `timeout` signals the child and
    leaves the promise pending — one that never settles hangs the turn;
  - **`spawn` has no `maxBuffer`**, so collection stops at a cap;
  - **the exit code** arrives on `close` and is `null` when a signal ended it.

- The property is asserted where it is observable: `sleep 0.4` with a 20 ms
  timer running, requiring at least five ticks. Under `spawnSync` there are
  none. `grep` shares the helper; a grep fast enough for a test is too fast to
  observe, and this says so rather than implying coverage it does not have.

- `npm test` is now 311 in ~1.0 s — the second spent waiting on real processes,
  which is the price of testing the thing rather than a mock of it. Negative
  control: `spawnSync` again fails exactly 1, timing out without killing fails
  exactly 1 (after the full 5 s), grep's `exit 1` treated as an error fails
  exactly 1 — that last one only after the control was fixed, having first come
  back green because the substitution never applied.

### Added — Startup probing has a suite (21 tests)

- `ToolLimitDetector` and `ThinkingDetector` each ask a question that costs real
  time and cache the answer under the model's id. Everything downstream stands on
  those numbers: `maxTools` chooses Path A or Path B, the thinking flags decide
  whether Claudio shows a toggle that does anything.

- **The interesting values are the falsy ones.** `maxTools: 0` is the probe
  saying the model could not manage a single tool; `supportsThinking: false` is a
  measured answer. Both files check `!== undefined` for that reason, and the
  suite pins it — reverting either to truthiness re-probes on every launch, which
  nobody reports as a bug because the proxy merely feels slow to start.

- `fetch` is stubbed and **counted**: "the expensive path was skipped" is the
  property, and a call count is the only way to see it. Also covered: the two
  detectors write into the same cache record and must not overwrite each other's
  half, a partial record is not a complete one, and `PersistentCache` treats a
  missing or corrupt file as empty and a failed write as nothing at all — the
  proxy re-probes next time rather than refusing to start.

- `npm test` is now 381. Negative control: truthiness on `maxTools` fails
  exactly 1, truthiness on the thinking flags fails exactly 2, `merge` replacing
  instead of merging fails exactly 3, and running the second thinking probe
  unconditionally fails exactly 1.

### Fixed — An approved plan was explained back instead of carried out

Found by running plan mode end to end for the first time. Three faults, all in
the six lines of `server.ts` that read the plan back when the user leaves plan
mode — the part no suite could see, because it lived in the wiring.

- **The plan carried no instruction.** It was prepended as `[Existing plan from
  …]` and nothing more, so the model read it and explained it back, changing not
  one file. Measured twice; then, with a preamble saying the user approved it and
  it is to be executed now, the same model on the same task edited the file. That
  before/after is the change's whole justification.

- **A message made of content blocks was skipped.** Claudio sends an array
  whenever the message carries an attachment, so approving a plan with a file
  attached ran the turn with no plan at all — silently.

- **Containment was `startsWith(workspaceCwd)`** — the fourth copy of that
  mistake here, and the first where the path comes from a client header. For a
  workspace of `/ws`, `/ws-evil/secret.md` passed and its contents went into the
  prompt. It uses `safeResolvePath()` now, like everything else.

- The logic moved into `application/services/planExitInjection.ts` with 12 tests,
  which is also the point: out of the untested wiring and into a unit.
  `npm test` is now 360. Negative control: `startsWith` again fails exactly 1,
  skipping block arrays fails exactly 2, dropping the preamble fails exactly 1 —
  each verified after the first attempts silently matched nothing.

- Measured while there: **plan mode is model-dependent.** Across runs the model
  wrote a plan and stopped, wrote a plan and called `exit_plan_mode`, and called
  `exit_plan_mode` immediately without writing anything. The proxy handles all
  three. `chat-extension/scripts/plan-mode-e2e.ts` retries for that reason.

### Added — The routing use case has a suite (21 tests)

- `handleChatMessageUseCase` decides which proxy the client is talking to —
  Path A, Path B, or a pure translator — and it was the largest gap
  `docs/testing.md` listed. None of its failure modes throw: Claudio silently
  loses its agent, the CLI silently gets a system prompt written for Claudio, a
  `"fallthrough"` read as `"handled"` answers with silence.

- Path A is a recording stub; Path B is told apart by what reaches the backend,
  since it strips `tools` from a request the plain forward carries through. Also
  covered: the capability guard and the two neighbouring cases that must *not*
  400, the three shapes a system prompt arrives in, the budget compaction is
  given (`0` when the backend exposes no metadata), and the four ways an answer
  comes back — error with status, connection refused (502, never status 0), a
  backend that ignores `stream: true`, and a real stream.

- `npm test` is now 308 in ~410 ms. Negative control, six fronts, one test each:
  routing to Path A regardless of `maxTools`, treating fallthrough as handled,
  injecting the agent prompt without a workspace, removing the guard, guessing a
  context budget, and passing status 0 through as an HTTP status.

### Fixed — One malformed tool call killed the next iteration

- Found by running the image path end to end against LM Studio, which is the
  only way it *could* be found: the turn died one iteration in and put a raw
  HTML error page in the answer.

- The model emitted a `workspace` call with **empty arguments**. Execution
  already tolerated that — unparseable arguments fall back to `list .` — but the
  loop replays its own history verbatim, and an assistant `tool_calls` entry
  whose `arguments` is not a JSON object string is refused by the backend:
  `""` → 500, `"   "` → 500, a truncated `{"action":` → 500, `"null"` → 400,
  `"{}"` → 200. Measured, not assumed.

- Arguments are now normalised where the assistant turn is built, to the same
  fallback the executor uses, so the replayed call agrees with the tool result
  next to it. A replacement is logged: a model producing unusable calls is worth
  seeing even now that the turn survives it.

- `"null"` needed its own test. `JSON.parse` accepts it, so a guard that only
  catches a throw lets it past, and reading `.action` off `null` ends the turn —
  which it was still doing in three more places in the same file.

- The Path A fake could only express arguments as an object it serialised, so it
  could not produce what a real model writes. It takes a raw string now.

- 4 tests; `npm test` is now 287. Negative control: replaying verbatim fails
  exactly 3, accepting anything `JSON.parse` accepts fails exactly 1.

### Changed — CI runs on request, not on every commit

- `.github/workflows/ci.yml` no longer fires per push or per pull-request
  commit. It runs on `workflow_dispatch` only:
  `gh workflow run ci.yml --ref <branch>`.

- A `[ci]` marker in the commit message was the second channel, and it lasted
  one commit: the commit introducing it described it, so it contained it, so it
  triggered the run it existed to withhold. Any token common enough to type is
  common enough to write about.

- Stated plainly because it cuts against why the workflow was added: **nothing
  automatic now stands between a broken commit and `main`.** `npm test` and
  `npm run typecheck`, run locally before committing, are the gate — the same
  two commands, minus the machine that used to remember them for you.

### Added — A `python` figure is also written into the workspace

- **`PYTHON_PLOT_DIR`** (default `.claudio/plots`, empty disables) receives the
  PNG as `plot-YYYYMMDD-HHMMSS.png`, and the result names the path — for a
  vision model *and* a text-only one. The attached image is what the model sees;
  the file is the only handle a person has on a picture that otherwise exists
  solely inside the conversation.

- The name carries a counter as well as the clock, because two plots in the same
  second is the ordinary case — the model draws, looks, redraws — and a name
  taken from the clock alone would lose the first one. The write uses `wx`, so
  an existing file is never overwritten.

- **The write is contained** by the same `safeResolvePath()` as every other
  write: a misconfigured plot directory cannot point outside the workspace. It
  is the output of an action the user already approved (`python` is destructive
  and passes the gate), confined to the configured directory under the root.

- **A save that fails says so.** The result carries the reason and the image
  still reaches the model: the figure is lost, the turn is not.

- Nothing prunes the directory. Worth a `.gitignore` line; not worth code that
  deletes the user's files.

- 8 tests; `npm test` is now 283 in ~400 ms. Negative control: one name per
  second fails exactly 1, dropping containment fails exactly 1, swallowing the
  save error fails exactly 1, leaving the path out of the notice fails exactly 2.

- `executeAction`'s trailing `venvDir` became an `ActionEnv` object carrying both
  directories, rather than growing a second positional string through both loops.

### Changed — A `python` figure reaches the model as an image

- **`executeAction` now returns an `ActionOutcome`** — `text` for the model plus
  an optional `image` — instead of a bare string. The one action that produced a
  picture, `python` with a matplotlib figure, was returning the PNG's **base64 as
  the tool-result string**: tens of thousands of tokens of unreadable text,
  counted in full, teaching the model nothing.

- **Where the image can go is decided by the wire format**, not by preference,
  and both constraints are easy to get silently wrong:

  - `role: "tool"` takes a string, so the image cannot ride in the result;
  - every tool result of an assistant turn must follow that turn with nothing
    wedged between, so the image cannot go straight after the result that
    produced it either.

  Path A therefore appends every tool result first and then **one** user message
  carrying the batch's images. Path B has no tool messages at all — its
  `<observation>` already is a user turn, so the image goes inside it, and the
  content stays a plain string when there is none. Both go through the new
  `application/services/actionOutcome.ts`.

- **Only when the model says it can see.** The image is attached when the loaded
  model reports `type: "vlm"`, resolved per turn like the iteration limit and the
  context budget. This trusts backend metadata, which this project otherwise
  refuses to do; the trade is deliberate, because a model wrongly declared `vlm`
  produces a rejected request — loud — while never attaching is the silent
  failure the change exists to remove. On a text-only model the result says an
  image was produced and was not attached, and suggests having the script save
  the figure to a file. Saying nothing would leave the model describing a picture
  it never received.

- Together with the estimator fix below, an attached image is now also *counted*
  as an image rather than as prose.

- 13 tests in `actionOutcome.test.ts`; `npm test` is now 275 in ~390 ms. Two of
  them read the shipped source rather than a fake — a helper nobody calls
  type-checks perfectly — asserting that neither loop shapes its own tool result
  and that both call sites resolve vision capability. Negative control: attaching
  each image next to its own result fails exactly 2, returning the payload as
  text fails exactly 5, attaching on a text-only model fails exactly 1, dropping
  the Path B attachment fails exactly 1, and reverting either wiring site fails
  exactly 1.

- Known residue: if compaction drops the assistant turn a batch answered, the
  repair removes the orphaned tool messages and the image user-message survives
  on its own. It is a valid request and a small waste, not a break.


### Fixed — An attached image threw the conversation away

- **`estimateTokens()` measured base64 payloads as prose.** At 4 characters per
  token, a 500 KB screenshot scores ~171 000 tokens — more than the whole loaded
  window, for one attachment a vision model charges a few hundred tokens for.

  Nothing failed, which is why it survived: the request still went through. What
  happened instead is that compaction fired on a conversation that fit, and
  `naive` keeps the first message and the last two — so the picture survived and
  the history around it did not. **Attaching a screenshot silently reset the
  conversation.**

- Images are now charged a flat nominal `IMAGE_TOKEN_COST` in place of their
  payload, in **both** message shapes: `source.data` on an Anthropic image block
  and the `data:` URI in `image_url.url` after translation. Compaction runs on
  both sides of the translation, so counting only one of them would have fixed
  the incoming request and left the agent loops wrong.

- **The summariser was being sent the payload too.** The semantic strategy
  embeds the history in its prompt verbatim, so a megabyte of base64 was going
  to a text model to be summarised. It now receives the same payload-free
  serialisation, with `[image data omitted]` in place of the data.

- Four tests in `contextCompactor.test.ts`; `npm test` is now 261 in ~370 ms.
  Negative control: measuring payloads as prose again fails exactly 2, putting
  the payload back in the summary prompt fails exactly 1.


### Added — Cross-session memory

- **`.claudio/MEMORY.md`** (workspace-relative, configurable via `MEMORY_FILE`,
  empty string disables) is prepended to the system prompt whenever it exists,
  so a convention or a decision recorded last week survives a restart of the
  proxy, the editor and the conversation.

  New `MemoryRepositoryPort` + `FsMemoryRepository`, injected into
  `SystemPromptBuilder`, which was already the only injection point. Capped at
  8 KB; every failure to read — missing file, a directory in its place, no
  permission — degrades to "no memory" rather than to a failed request.

- **There is deliberately no `save()` on the port.** The model updates the file
  through the ordinary `write` action, which means every update passes the
  approval gate like any other write to disk. A dedicated write path would have
  been a second one, ungated.

- **No memory means no section**, not an empty heading and not "(no memories
  yet)". Every token spent on an empty section is taken from the conversation,
  and on these models the context window is the scarce resource in the project.

### Added — Prompt builder test suite (11 tests) and memory repository suite (8)

- **`test/systemPromptBuilder.test.ts`** — the first tests for what every
  workspace request is prefixed with: mode selection, the textual tail on Path B,
  an existing plan being offered back, and the memory section.

- One of them checks the **shipped templates**, not the fake: every parameter the
  builder computes must have a `{{placeholder}}` in the corresponding
  `prompts/en_US/*.md`. A parameter no template interpolates is silently dropped
  — no error, no warning, a feature that quietly never happens.

  It caught this feature shipping broken: memory was wired end to end and
  `agent-base.md` had no `{{memorySection}}`, so the ten tests above passed
  against a prompt that would never have contained it. It also caught a
  pre-existing case — `plansDir` was computed for the base prompt, which has
  never used it — now passed only to the plan-mode template that does.

- Negative control: removing the placeholder from the real template fails
  exactly 1 test, emitting an empty section instead of none fails exactly 1, and
  dropping the `.trim()` on the memory file fails exactly 1.

- `npm test` was 257 tests in ~430 ms at this entry.


### Fixed — Path B ignored the configured iteration limit

- **`MAX_ITERATIONS = 10` was hardcoded in `textualAgentLoop`** while the 1.3.0
  entry below announced that `MAX_AGENT_ITERATIONS` "replaces the hardcoded limit
  of 10". It replaced it in Path A only, and the claim was left unqualified.

  The direction of the error is the part that matters: on a small context window
  the adaptive tier resolves *below* ten, so a hardcoded ten meant ten rounds of
  observations pushed into a window sized for fewer. Path B now receives the same
  resolved ceiling Path A uses.

- **`runTextualAgentLoop`'s optional tail is now a `TextualLoopOptions` object.**
  It had eleven positional parameters and this change would have added a
  twelfth — the call site already carried an `undefined` placeholder.

### Documentation — one recorded gap that was not one

- PLAN.md listed "missing parallel dispatch of read-only actions" against Path B.
  It is not missing, it does not apply: the tag parser stops at the first
  complete tag and discards the rest of the turn, which is exactly what
  `TEXTUAL_TOOL_MANUAL` tells the model to do ("Emit exactly one action at a
  time"). There is never a second action to dispatch. A test now pins that the
  parser and the manual agree, and `docs/agent-loop.md` no longer shows a
  hardcoded `(10)` in the Path B trace.


### Fixed — Compaction could produce a conversation the backend rejects

- **Trimming by position cuts through `tool_use` / `tool_result` pairs.** After
  translation those become an assistant turn carrying `tool_calls` and the `tool`
  messages answering it, and an OpenAI-compatible backend rejects the request
  outright when either half has lost its partner — a result answering nothing, or
  a call the backend is still waiting on.

  Compaction runs exactly when a conversation has grown long, which in this proxy
  means exactly when it is mostly tool calls and their results. So the failure
  arrives only in long sessions: the ones where losing the turn costs most.

  `repairToolPairing()` now runs after every trim, drops whichever half was
  orphaned, keeps any text that shared the message with it, and understands both
  message shapes — Anthropic content blocks for the incoming request, and
  `tool_calls` / `role: "tool"` for the loops trimming their own history.

### Added — Compaction inside the agent loops

- **`services/contextCompactor.ts`** — extracted from `handleChatMessageUseCase`,
  which was the only caller. Both agent loops now compact between iterations.

  Compaction on the incoming request cannot help with a turn that grows *after*
  it starts: each iteration appends an assistant turn and one tool result per
  call, and `read` truncates at 50 KB, so a handful of large reads crosses the
  window. The old behaviour was a 400 from the backend mid-turn, after the user
  had already watched half a reply arrive.

  Path B gets it too. It is a documented fallback, but a fallback that dies
  halfway through is worse than one that answers briefly.

- **`test/contextCompactor.test.ts`** (20 tests) — both strategies, the summary
  timeout, the unknown-window case, and the pairing invariant in both shapes.
  Plus three tests in the loop suites for mid-turn compaction.

- One test was rewritten after it passed: the first version built evenly-sized
  call/result pairs, so messages dropped two at a time and the pairing survived
  by arithmetic rather than by the code being right — it passed against the bug.
  It now makes the call enormous and its answer tiny, so exactly one message
  drops and the cut lands mid-pair every time.

- Negative control: disabling `repairToolPairing` fails exactly 5 tests, and
  skipping compaction between iterations fails exactly 1 in each loop suite.

- `npm test` is now 236 tests in ~410 ms.


### Added — Path A test suite (19 tests) — every component now has one

- **`test/nativeAgentLoop.test.ts`** — the loop that runs on a model with native
  tool calls. The fallthrough contract (both that `run()` returns
  `"fallthrough"` on a silent iteration 0, and that it wrote nothing to the wire
  before doing so, since the caller replays the turn); the tool-call round trip
  including the assistant turn being replayed so the follow-up request stays
  valid for OpenAI; batched execution; approval scopes; plan mode; the iteration
  ceiling as a message the user can read; a backend error ending the turn; and a
  JSON body arriving in answer to a `stream: true` request.

- **No bugs found.** Path A is the path exercised every day, which is the most
  likely reason.

- One test was rewritten after it passed: "destructive calls are asked about one
  at a time" originally counted approval prompts, and two writes produce two
  prompts whether they run in sequence or in parallel. It now measures whether a
  second modal opens while the first is still waiting, and parallelising the
  destructive branch makes it fail.

- Negative control: never returning `"fallthrough"` fails exactly 2 tests,
  dropping the assistant tool_calls turn from the replay fails exactly 1, and
  running destructive calls in parallel fails exactly 1.

- `npm test` is now 212 tests in ~400 ms. Every component of the proxy has a
  suite; what remains is recorded in `PLAN.md` as decisions rather than gaps.


### Fixed — Path B could not edit a file, and its documented write form was never executed

`TEXTUAL_TOOL_MANUAL` is the entire instruction set handed to a model without
native tool calls. Two of its examples were not implemented.

- **`edit` never worked.** The manual teaches
  `<action name="edit" path="…" old_string="…" new_string="…"/>`, but
  `parseActionTag` read only `name`, `path`, `pattern`, `include` and `cmd`. A
  model following that example exactly produced an action carrying neither
  string, and `executeAction` answered `Error: 'old_string' is required` — every
  time, for every edit, on every Path B model.

- **`write` in the documented body form was printed, not performed.** The manual
  teaches `<action name="write" path="hello.txt">` … `</action>`, and the parser
  looked only for `/>`. The tag never closed, stayed buffered to the end of the
  stream, and the remainder flush emitted the whole thing to the client as prose.
  No file written, no error raised, and nothing told to the model.

  The tag scan is now quote-aware, so a `>` inside an attribute
  (`cmd="ls > out"`) no longer ends the tag early and truncates its arguments.

  Path B is a fallback and documented as second-class, which is presumably how
  this survived — on any model with native tool calls it never runs.

### Added — Path B test suite (17 tests)

- **`test/textualAgentLoop.test.ts`** — drives the real loop with a scripted LLM
  and a real temporary workspace, asserting on both what reached the client and
  what reached disk. Covers tag parsing across chunk boundaries (down to one
  character per chunk), prose that merely mentions a tag, malformed tags, the
  observation round trip, approval scopes including "allow for this turn", the
  iteration ceiling being visible to the user, and a backend error ending the
  turn cleanly.

- One test derives the attribute list from `TEXTUAL_TOOL_MANUAL` and asks
  `parseActionTag` about each one, rather than checking against a list written
  in the test. A hardcoded list would have passed at exactly the moment it
  needed to fail — which is how the first draft of that test passed against both
  bugs above.

- Negative control: removing `old_string`/`new_string` from the parser fails
  exactly 2 tests, dropping the body form fails exactly 1.

- `npm test` is now 193 tests in ~350 ms.


### Fixed — `edit` corrupted replacements containing a dollar sign

- **`actionEdit` passed `new_string` straight to `String.prototype.replace`**,
  which treats `$$`, `$&`, `` $` `` and `$'` inside the replacement as patterns
  rather than text. `$$` collapsed to `$`, `$&` expanded to the text being
  replaced, `$'` to everything after it.

  An edit inserting Makefile or shell source therefore wrote something other than
  what the model asked for, returned `Replaced 1 occurrence`, and left no trace
  anywhere. Now goes through a replacer function, which inserts the string
  literally.

### Fixed — A trailing slash on the workspace root refused every path

- **`safeResolvePath()` compared against `workspaceCwd + "/"`** without
  normalising the root first, so a root arriving as `/ws/` from the
  `X-Workspace-Root` header was tested against `/ws//` and every path inside the
  workspace resolved as an escape. Every action would have failed with "outside
  the workspace root". The root now goes through `resolve()`, and the separator
  comes from `node:path` rather than a hardcoded `/`.

### Added — Workspace actions test suite (34 tests)

- **`test/workspaceActions.test.ts`** — `safeResolvePath` containment from every
  direction (absolute, `~`, `..`, sibling prefix, the root itself), each action's
  success and failure strings, `read` truncation, `write` creating parent
  directories, `edit` replacing only the first occurrence, glob traversal and
  brace alternation, and bash's stderr labelling, exit codes and empty output.

  `safeResolvePath` is the check that two *other* places in this codebase got
  wrong on this branch, and both times this one was right. Nothing pinned it,
  which was the only reason to be nervous about it.

- The final test walks eight failing calls and asserts only that each returned a
  string. `executeAction` documents that it never throws, and the difference
  matters: a string is an observation the model can react to, an exception ends
  the turn.

- Negative control: passing `new_string` to `replace()` directly fails exactly 1
  test, skipping `resolve()` on the root fails exactly 1, and dropping the
  separator from the containment check fails exactly 1.

- `npm test` is now 176 tests in ~250 ms.


### Fixed — An allowlist rule could approve far more than it said

- **A constraint that does not apply to the action was treated as satisfied.**
  The guards in `checkAutoApprove()` read
  `rule.pathPattern && args.path && !test(args.path)`, so when the argument was
  absent the whole condition short-circuited and the rule matched. A
  `pathPattern` written against `bash` — which carries a command and never a
  path — therefore approved **every** shell command without asking:

  ```json
  { "action": "bash", "pathPattern": "^scripts/" }
  ```

  That is an easy rule to write, it is the exact opposite of what it says, and it
  produces no error, no log line and no visible difference until something
  destructive runs unprompted — in the one file whose entire job is to be
  restrictive.

- **A pattern that does not compile took the turn down.** `new RegExp()` sat
  outside the `try` that covers the read and the JSON parse, so a typo threw
  through `ApprovalGateService` and out of the request, despite the function
  documenting that it fails quietly on a bad config.

  Both now go through one helper that returns false when the value is absent and
  false when the pattern will not compile. A rule stating no pattern at all still
  matches everything for its action — that is an explicit blanket and is
  deliberate.

  **Behaviour change:** this only ever moves toward asking more, but a config
  that was silently broader than written will start prompting.

- **`loadOldContent()` used `startsWith` for workspace containment**, the same
  weakness fixed in `ApprovalGateService` earlier in this release. Here it
  decided whether a file may be read into the approval modal as the "before"
  side of a diff, so a sibling directory sharing the workspace's prefix
  (`/ws-evil` against `/ws`) could be read. Now uses `relative()`.

### Added — Allowlist test suite (22 tests), completing the Phase 1 list

- **`test/autoApproveConfig.test.ts`** — rule matching and its scope, patterns
  that fail closed, unusable regexes, first-match-wins, the deliberate blanket
  rule, and `loadOldContent`'s containment and truncation. Uses a real temporary
  directory: the function's whole purpose is reading a file from a known
  location, and stubbing that away would leave the part worth testing untested.

- Negative control: treating an unevaluable constraint as satisfied fails
  exactly 2 tests, letting an unusable regex propagate fails exactly 2, and
  restoring the `startsWith` containment fails exactly 1.

- `test/approvalGate.test.ts` now uses `cmd` rather than `command` for bash
  arguments. `ActionArgs` has an index signature, so the wrong key type-checked
  cleanly while describing a shape the model never sends.

- `npm test` is now 142 tests in ~200 ms. Every component on the Phase 1
  priority list is covered; the two agent loops and `workspaceActions` remain,
  and are the surface `scripts/regression.sh` still catches best.


### Added — ToolManager test suite (23 tests)

- **`test/toolManager.test.ts`** — what decides which ~6 of Claude Code's ~40
  tools a local model is actually offered. Covers the reserved `UseTool` slot and
  the exact budget, overflow reachability (every tool either sent or listed),
  per-tool description truncation, scoring, tie stability, `UseTool` call
  rewriting, and promotion decay.

  The suite runs on the real default weights rather than round test numbers,
  because the behaviour is in how they compare: a promoted tool scores 8 against
  a core tool's 10 and never displaces one on its own, while promoted *and* seen
  in history is 13 and does. The documented auto-promotion works because the
  bonuses stack — calling a tool through UseTool also puts it in the history —
  not because promotion is strong enough alone. That distinction is now pinned.

  Negative control: removing the reserved UseTool slot fails 3 tests, reversing
  tie order fails 5, never ageing promotions fails 2, and making scoring
  non-additive fails 1.

- **No bugs found in `toolManager.ts`.** Four were found in the tests
  themselves, and both classes are invisible in a green run:

  - The suite used a limit of 7 against a set of exactly 7 tools. `selectTools`
    returns early when `allTools.length <= maxTools`, so nothing was filtered —
    the tool under test was trivially present and four tests verified nothing.
    The limit is now a named constant carrying the reason, and tests that depend
    on filtering assert `useToolDef !== null` first.
  - Two more asserted on a `UseTool` description that, with no locale loaded, is
    the bare key `useTool.description`. The suite now loads the real locale in a
    `before` hook, which also exercises the real template.

  Also recorded in `docs/testing.md`: a negative control that comes back green
  may mean the test is weak *or* that the control never introduced the bug.
  Breaking the tie sort with `(b.score - a.score) || 1` reorders nothing —
  V8's insertion sort only moves on a negative comparator — while `|| -1` does.

- `npm test` is now 120 tests in ~170 ms.


### Fixed — UseTool arguments were accumulated twice, breaking tool overflow

- **`streamTranslator` seeded a streamed tool call's `arguments` with the first
  delta's fragment**, which the accumulator on the next line then appended
  again. Normal tools never read that field — they forward
  `tc.function.arguments` untouched — so the damage fell entirely on `UseTool`,
  where the accumulated string is what `rewriteUseToolCall()` must `JSON.parse`.

  A call arriving whole in a single delta, which is the common shape, produced
  `{"tool":"Grep"}{"tool":"Grep"}`. The parse threw, the rewrite returned null,
  and the client received a `UseTool` block it cannot execute. The tool overflow
  path was broken — silently, with nothing logged — and only on models with a low
  enough tool ceiling to need it in the first place.

### Fixed — Thinking block pinned to index 0

- **`handleReasoning()` set `contentIndex = 0` unconditionally.** Reasoning
  almost always arrives first, so this was almost always right; a backend that
  emits a line of text *before* its reasoning got a thinking block opened on top
  of the live text block, and every text delta after it landed on an index that
  was never started — malformed for the Anthropic SDK, which is a parser. It now
  closes an open text block first, mirroring what `handleContent()` already did
  in the other direction, and remembers which index it used.

### Fixed — Whitespace padding still opened a text block while streaming

- **The existing guard only drops whitespace-only content once a tool call is
  known about**, but the usual order is the reverse: the model emits `"\n\n"`
  and *then* calls the tool, so by the time the padding could be recognised the
  block was open and the client was already rendering an empty bubble. The
  README described this case as handled; in streaming it was not. Whitespace
  that would open a text block is now held back — flushed ahead of the next real
  text, discarded if a tool call arrives instead.

### Added — Translator test suites (64 tests)

- **`test/requestTranslator.test.ts`** (25) — system prompt shapes, the two
  orderings that matter on the wire (tool results before the user text that
  follows them, image parts before their caption), tool and `tool_choice`
  mapping, `max_tokens` capping, and the explicit `enable_thinking` true/false.

- **`test/responseTranslator.test.ts`** (16) — block order, UseTool rewriting,
  stop-reason mapping including tool_use blocks outranking a backend that
  reports `"stop"`, and the never-empty content array the SDK requires.

- **`test/streamTranslator.test.ts`** (23) — the state machine. Every test also
  asserts one structural invariant, `assertWellFormed()`: each delta sits inside
  a start/stop pair for its own index and nothing is left open. Two of the three
  bugs above were caught by that helper rather than by the assertion the test
  was written for.

  The suite drives explicit chunk boundaries, because the boundaries are half
  the behaviour: a `data:` line split across two reads has to survive, and a
  usage-only chunk arriving after `finish_reason` still has to reach the final
  `message_delta`.

- **`test/fakes.ts`** — shared doubles. Not collected by the runner's glob, but
  included in `tsconfig.json`, so a fake that drifts out of shape with the
  interface it stands in for fails the typecheck. It records every argument
  string handed to `rewriteUseToolCall()`, which is what the UseTool regression
  test asserts on — the earlier version checked only the rewritten name, which a
  fake supplies regardless, and passed against the bug.

- Negative control on each fix: re-seeding the arguments fails exactly 3 tests,
  pinning thinking to index 0 fails exactly 1, dropping the whitespace buffer
  fails exactly 1.

- `npm test` is now 97 tests in ~165 ms, still with no GPU, no LM Studio and no
  model loaded.


### Fixed — Approval gate treated a sibling directory as inside the workspace

- **`ApprovalGateService` recorded `scope: "file"` grants** with
  `full.startsWith(workspaceCwd)`. That is not a containment test: with a
  workspace at `/ws` it also accepts `/ws-evil/secrets.txt`, because the
  comparison ignores the directory boundary. A grant on a path outside the
  workspace could therefore be recorded as trusted for the rest of the session,
  and every later write to it waved through without asking.

  Not exploitable: `safeResolvePath()` in `workspaceActions.ts` rejects the
  write independently, and gets the check right (`resolved.startsWith(cwd + "/")`,
  plus an outright refusal of absolute and `~` paths). The two layers simply
  disagreed about what "inside the workspace" means, and only the lower one was
  correct. Both sites in the gate now use `relative()`, which does not depend on
  separator juggling.

  Found by writing the tests below, not by observing a failure.

### Added — Approval gate test suite

- **`test/approvalGate.test.ts`** — 20 tests over the gate that gets between a
  local model and `write` / `edit` / `bash` / `python`. It covers the precedence
  chain (plan mode → auto mode → trusted files → allowlist → ask the user), which
  approval scopes persist and which must not, and workspace containment of a
  `scope: "file"` grant.

  About half the assertions are on *whether the modal was raised at all* rather
  than on the verdict. A gate that asks too often is an annoyance; a gate that
  quietly stops asking is the real failure, and nothing downstream reports it —
  the action just runs.

  Three of them exist for mistakes that would be invisible in use: `scope: "once"`
  silently becoming permanent if the persistence branch stopped discriminating
  on scope; `scope: "turn"` being persisted here and outliving the turn it was
  granted for (the two agent loops own that state); and the allowlist being
  consulted before plan mode, which would let a plan run edit files.

  Negative control on three fronts — reintroducing the `startsWith` check at both
  sites fails exactly 1 test, persisting every scope fails exactly 2, and moving
  the allowlist ahead of plan mode fails exactly 1.

  `npm test` is now 33 tests in ~160 ms, still with no GPU, no LM Studio and no
  model loaded.


### Documentation — README reconciled with the code it describes

- **`README.md` still described a Bun single-file server.** Requirements asked
  for Bun >= 1.0 and named `bun-types` as the only dependency; Quick Start ran
  `bun install` and `./start.sh`; the Scripts section documented `start.sh` and
  `start_claude_code.sh`, both deleted in v1.1.0; the File Structure block
  listed a `proxy/server.ts` of "~500 lines" built on `Bun.serve()`. The proxy
  has been Node + `tsx` with a hexagonal `src/` tree for several releases. All
  four sections rewritten against the source, plus a real file map and a note on
  where the layering rule is actually honoured and where it is not.

- **Three docs were unreachable from any index.** `agent-loop.md`,
  `permission-protocol.md` and `system-prompt-injection.md` existed but were
  linked from neither README. Added to both.

- **New [`docs/testing.md`](docs/testing.md)** — how to run the suites, why
  `node:test` over a framework, what each suite locks down, the negative-control
  results, the `pretest` guard, and the uncovered surface in priority order.

- **`docs/configuration.md`**: `PROBE_UPPER_BOUND` documented as `32` and
  `PROBE_TIMEOUT` as `30000` — both raised (64 / 60000) in this same release.
  The `MAX_TOOLS` example quoted per-model tool ceilings measured by the
  pre-fix probe, i.e. numbers produced by the latency bug; replaced with the
  measured `>= 96` on `qwen/qwen3.8-27b` and an explicit warning not to carry a
  ceiling across models.

- **`docs/architecture.md`**: header said v1.2.0; `server.ts` was called the
  composition root at "280 lines" when it is the HTTP router at 416 and
  `main.ts` is the composition root; the domain box listed a `ports.ts` holding
  `ILogger` instead of the seven-port directory. `thinkingProbe`,
  `thinkingDetector`, `pythonExecutor`, `prompts/` and `test/` were missing from
  the file map.

- **`nativeAgentLoopService.ts` docstring contradicted its own code**, still
  describing iteration 0 as a non-streaming probe. Every iteration has used
  `stream: true` since streaming was extended to the whole loop; iteration 0
  keeps only the fallback-guard role. The comment 200 lines below said so
  correctly, which is the kind of split that outlives whoever remembers it.


### Fixed — Tool probe ceiling was below the tool count that matters

- **`DEFAULT_PROBE_UPPER_BOUND` raised 32 → 64** (`infrastructure/config.ts`).
  The binary search stopped at 32, so any model able to handle more reported
  exactly 32 — the probe's own ceiling, not the model's. Claude Code CLI sends
  ~40 tool definitions per request, so `ToolManager.selectTools()` saw
  `40 > 32` and engaged the `UseTool` overflow path (31 core tools + meta-tool)
  on models that never needed it.

  Measured on `qwen/qwen3.8-27b` (MLX 4-bit, 119 552 token context): 32, 40, 48,
  64 and 96 tools all produce correct structured calls with the right tool
  selected. The real ceiling was never reached. Override with `PROBE_UPPER_BOUND`.

### Added — Test harness (first automated tests in the project)

- **`node:test`**, no new dependencies — `dependencies` stays `{}`. Tests live
  in `proxy/test/` and are covered by `tsc --noEmit`. `npm test` runs 33 tests
  in ~160ms with no GPU, no LM Studio and no model loaded, which is what makes
  it usable as a merge gate; `scripts/regression.sh` needs a live backend and
  never could be.

- **`test/i18n.test.ts`** — every key passed to `t()` exists in every locale,
  every locale is a *flat* map of strings, and locales do not drift apart.
  `t()` returns the key itself when a lookup misses, and locale files are read
  through `JSON.parse`, so a nested object type-checks fine and surfaces to the
  user as a raw key. This suite exists because that mistake was made, and
  caught by hand, while adding `tools.unsupportedByModel`.

- **`test/toolProbe.test.ts`** — 8 tests over the outcome triage: a refusal
  searches downward, a timeout is retried, an HTTP error is not read as a
  capability, a persistent timeout caps the search and says so. Includes a
  regression test reproducing the observed trace — a slow reply at n=48 against
  a model that handles 64 — which reports `actual: 47` against the pre-fix code.

- **`pretest` guard**: `node --test` exits 0 when it matches no files, so a
  broken glob would have produced a green build that verified nothing. The
  script now fails loudly instead.

### Fixed — Probe read timeouts as capability limits

- **`ToolProbe` now triages each attempt** into `tool_calls` / `no_tool_calls` /
  `inconclusive` instead of collapsing everything into a boolean. The old
  `catch { return false }` made a timeout, a dropped connection and an HTTP 500
  indistinguishable from "the model refused to emit a tool call" — and since a
  larger tool array means a larger prompt and a slower reply, timeouts cluster
  exactly at the boundary the binary search is trying to find. The search was
  therefore measuring latency, not capability.

  Observed on `qwen/qwen3.8-27b` (MLX 4-bit) with `PROBE_UPPER_BOUND=64`:

  ```
  32 tools → ✅      (11s)
  48 tools → ❌      (30.007s — exactly PROBE_TIMEOUT)
  40 tools → ✅      (7s)
  44 tools → ✅      (9s)
  46 tools → ✅      (11s)
  47 tools → ✅      (12s)
  Max tools detected: 47
  ```

  47 is an artefact. Direct measurement against the same loaded model shows 96
  tools still produce correct structured calls; n=48 simply did not answer in
  time, and one slow reply capped the reported ceiling.

- **Inconclusive attempts are retried once** at `PROBE_TIMEOUT × 3` before the
  search accepts them, and are logged distinctly (`probe.result.timeout`).

- **The final log line now states its own confidence**: `probe.detected.capped`
  when a timeout truncated the search (the number is a floor, not a limit), and
  `probe.detected.atBound` when the search reached `PROBE_UPPER_BOUND` without
  a failure (the model may handle more). Previously all three cases printed the
  same "Max tools detected: N".

- **`DEFAULT_PROBE_TIMEOUT` raised 30s → 60s.** Probe latency scales with the
  tool array; at 47 tools a reply already took 12s, leaving little headroom.

### Added — Tool-calling capability guard

- **`HandleChatMessageUseCase`** now rejects, with HTTP 400 and an explicit
  message, any request that carries tool definitions when `maxTools == 0` and
  no `X-Workspace-Root` header is present.

  `0` had three incompatible readings: `ToolProbe.detect()` returns it for
  "this model cannot do tool calling"; the agent-loop routing reads it as
  "use the textual Path B loop" (which needs `workspaceCwd`); and
  `ToolManager.selectTools()` reads `maxTools <= 0` as "filtering disabled,
  forward everything". A tool-carrying client without the header — i.e. Claude
  Code CLI — therefore had all ~40 of its tools forwarded verbatim to a model
  that had just failed a single-tool probe, producing garbage instead of an
  error. The collision is now documented at the `selectTools()` call site.

- New locale key `tools.unsupportedByModel` (`locales/en_US.json`).

### Fixed — Documentation drift

- `toolLimitDetector.ts` docstring claimed the probe runs "after the HTTP
  server is already listening". `main.ts` awaits `initializeTools()` *before*
  `start()`; corrected.
- `requestTranslator.ts` docstring listed image blocks as "skipped" directly
  above the code that translates them into OpenAI `image_url` data URIs.

---

## [1.4.0] — 2026-04-12

### Added — Python execution engine

- **`pythonExecutor.ts`** (`infrastructure/`): new module that owns the full
  Python execution lifecycle — venv creation, missing-package detection and
  auto-install (`pip`), matplotlib `plt.show()` interception (returns base64
  PNG), and code execution with a 30-second timeout. Per-workspace venv at
  `<workspaceCwd>/<PYTHON_VENV_DIR>` (default `.claudio/python-venv`).

- **`python` workspace action** (`WorkspaceAction.Python`): the agent loop can
  now execute Python snippets via `workspace(action="python", cmd="…")`.
  Classified as `Destructive` — requires user approval before execution, same
  as `bash`. The `cmd` parameter carries the Python source code.

- **`POST /v1/exec-python`** endpoint: SSE stream for the Run button in the
  chat UI. Emits `progress` events (`creating_env`, `installing_packages`,
  `executing`) followed by a single `result` event
  (`{type:"text"|"image"|"error", data:string}`). No approval gate — the
  user explicitly clicked Run.

- **`PYTHON_VENV_DIR`** config variable: controls the venv location relative
  to the workspace root. Default: `.claudio/python-venv`.

- **`X-Plan-Exit-Path` header** (`POST /v1/messages`): when the extension
  sends this header, the proxy reads the plan file from disk and prepends its
  content to the last user message. Removes plan-file I/O from the extension;
  includes a path-traversal guard (resolved path must stay within `workspaceCwd`).

### Changed — Agent loop internals

- `executeAction()` is now `async` — required for the Python case which awaits
  `executePythonCode()`. All five call sites in `nativeAgentLoopService.ts`
  and `textualAgentLoop.ts` updated with `await`.
- `NativeAgentLoopService` constructor gained an optional `venvDir` parameter
  (default `.claudio/python-venv`); forwarded to `executeAction()`.
- `runTextualAgentLoop()` gained an optional `venvDir` parameter; forwarded
  to `executeAction()`.
- `HandleChatMessageUseCase` constructor gained an optional `venvDir`
  parameter; forwarded to `runTextualAgentLoop()`.

---

## [1.3.0] — 2026-04-12

### Added — Advanced agent loop features

- **Configurable iteration limit** (`MAX_AGENT_ITERATIONS`): replaces the hardcoded limit of 10.
  The value now acts as a **hard cap**; the proxy derives the effective limit from the model's
  loaded context window automatically (see Adaptive behaviour below). Default cap: `40`.

- **Parallel read-only tool execution**: when the model returns multiple `workspace` tool calls
  in a single turn, `list`, `read`, `grep`, and `glob` actions are now dispatched in parallel
  via `Promise.all`. Destructive actions (`write`, `edit`, `bash`) remain sequential — the
  approval gate is one-at-a-time by design. Tool results are reassembled in the original order
  before being appended to the conversation (OpenAI requires matching order).

- **Semantic context compression** (`SEMANTIC_COMPACT`, `SUMMARY_MAX_TOKENS`, `SUMMARY_TIMEOUT`):
  when the conversation exceeds 80% of the model's context window, the proxy now attempts an LLM
  summarization call instead of naively dropping messages. The summary preserves file names,
  decisions, code written, and errors encountered. Falls back to naive trimming automatically if
  the LLM call fails or times out. Enabled by default (`SEMANTIC_COMPACT=true`).

### Added — Adaptive configuration

- **Adaptive iteration limit**: `computeMaxIterations()` in `ProxyServer` derives the effective
  iteration ceiling from `loadedContextLength`:

  | Context window | Effective limit |
  |---|---|
  | unknown | 20 |
  | ≤ 8 K | 10 |
  | 8–32 K | 20 |
  | 32–64 K | 30 |
  | ≥ 64 K | 40 |

  The value is recomputed on every turn via a resolver function — model changes detected by the
  15-second poll loop (`pollModelChange`) take effect immediately without a proxy restart.
  `MAX_AGENT_ITERATIONS` remains available as a hard cap override.

- **Adaptive summary budget**: `computeSummaryMaxTokens()` sets the summarization token budget
  to `~2%` of the context window (floor 256, cap `SUMMARY_MAX_TOKENS`). Larger models get more
  verbose summaries; smaller models get concise ones that leave more room for actual content.

### New environment variables

| Variable | Default | Description |
|---|---|---|
| `MAX_AGENT_ITERATIONS` | `40` | Hard cap on agent loop iterations per turn. Proxy derives effective limit from context window; this prevents runaway loops. |
| `SEMANTIC_COMPACT` | `true` | Use LLM summarization for context compaction instead of naive message trimming. |
| `SUMMARY_MAX_TOKENS` | `512` | Max tokens for the summarization call (capped further by `~2%` of context window). |
| `SUMMARY_TIMEOUT` | `15000` | Timeout ms for the summarization call before falling back to naive trimming. |

---

## [1.1.0] — 2026-04-10

### Added — Proxy lifecycle management

- **`start_agent_cli.sh`**: new unified CLI script replacing `start.sh` + `start_claude_code.sh`.
  Performs port discovery (`find_free_port`), spawns the proxy, waits for `/health`, presents an
  interactive model selector if `ANTHROPIC_MODEL` is unset, launches Claude Code, and kills the
  proxy automatically on exit via `trap`.

- **Port discovery** (`find_free_port` in bash): each CLI session finds the first available port
  starting from `PROXY_PORT` (default 5678) using `lsof`. Multiple parallel agents run on
  independent ports without conflicts.

### Removed

- **`start.sh`**: functionality absorbed by `start_agent_cli.sh`.
- **`start_claude_code.sh`**: functionality absorbed by `start_agent_cli.sh`.

### Added — Previously unreleased

- **Slash command interceptor** (`src/application/slashCommandInterceptor.ts`): intercepts slash
  commands from incoming requests before the LLM is called. Three result types:
  - `synthetic` — immediate SSE response without any LLM call (e.g. `/status`, `/version`)
  - `enrich` — replaces the last message with enriched content, then proceeds to LLM (e.g. `/commit`, `/diff`, `/review`)
  - `passthrough` — not a handled command, normal flow continues
  - Proxy-handled: `/status`, `/version`, `/commit`, `/diff`, `/review`, `/compact`, `/brief`, `/plan`
  - Client-handled (registry only): `/copy`, `/files`, `/simplify`, `/branch`, `/commit-push-pr`, `/pr-comments`, `/clear`
  - Blocked Anthropic-specific commands return a synthetic explanatory message

- **Workspace tool** (`src/application/workspaceTool.ts`): OpenAI-format tool for filesystem
  exploration inside the workspace root:
  - `action: "list"` — lists directory contents
  - `action: "read"` — reads file content (max 50KB)
  - `safeResolve()` — prevents path traversal outside the workspace root
  - Static summary fallback: when models don't support tools, injects workspace context as system prompt

- **Agentic workspace exploration loop** (`src/infrastructure/server.ts`): when the client sends
  `X-Workspace-Root` and `maxTools > 0`, runs up to 10 non-streaming rounds with only the
  `workspace` tool. Final result is streamed as a single Anthropic SSE response.

- **Persistent model cache** (`src/infrastructure/persistentCache.ts`): JSON file-backed cache
  storing `{ "<modelId>": { "maxTools": N } }` in `proxy/model-cache.json`. Skips the binary
  search probe on subsequent starts with the same model.

- **Split initialization** (`src/main.ts` + `src/infrastructure/server.ts`):
  - `proxy.initialize()` — fast path (~100–300ms): locale + model info
  - `proxy.start()` — HTTP server starts; health check passes here
  - `proxy.initializeTools()` — background (3–30s): cache check or probe + wires translators.
    Requests before completion receive `503 Proxy is still initializing`.

- **`PROBE_TIMEOUT` config variable**: timeout per probe fetch request (default: 30,000ms).

- **Chat defaults** exposed via `GET /config`:
  - `TEMPERATURE` — LLM temperature (default: 0.7)
  - `SYSTEM_PROMPT` — prepended system prompt (default: empty)
  - `ENABLE_THINKING` — send `thinking:{type:"enabled"}` (default: 1)

- **`GET /config` endpoint**: returns proxy runtime config including model info, temperature,
  system prompt, locale, maxTokensFallback. Used by Claudio to auto-configure.

- **`GET /commands` endpoint**: returns the full slash command registry. Used by Claudio for
  command autocomplete.

---

## [1.0.0] — 2026-03-31

### Added

- Initial Anthropic-to-OpenAI translation proxy
- Full SSE streaming: Anthropic SSE events translated from OpenAI SSE chunks via `StreamStateMachine`
- Dynamic tool selection with additive scoring algorithm (core tools, promoted, history, forced choice)
- `UseTool` meta-tool: overflow tools in a single meta-tool, transparently rewritten to the real tool name
- Auto-promotion with decay: tools invoked via UseTool are promoted for `PROMOTION_MAX_AGE` requests
- Binary search tool probe (`ToolProbe.detect()`): auto-detects model's maximum tool count at startup
- Model info fetch from LM Studio's `/api/v0/models`: architecture, quantization, context length, capabilities
- `max_tokens` capping: caps Claude Code's `max_tokens=32000+` to `loadedContextLength / CONTEXT_TO_MAX_TOKENS_RATIO`
- Hexagonal architecture: domain (pure types + i18n), application (translators + tool manager), infrastructure (server + config + logger)
- i18n: locale files in `proxy/locales/`, `t()` function with `{{param}}` interpolation
- Thinking block translation: `reasoning_content` → Anthropic `thinking` content blocks
- Stop reason mapping: `finish_reason` → `stop_reason` (end_turn, tool_use, max_tokens)
