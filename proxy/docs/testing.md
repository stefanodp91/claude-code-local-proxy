# Testing

> How the proxy is tested, what is covered, and what is deliberately not.

---

## Running the suites

```bash
cd proxy
npm test          # 13 tests, ~160 ms
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
  i18n.test.ts       5 tests — locale integrity
  toolProbe.test.ts  8 tests — probe outcome triage
```

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

---

## Negative control

Every suite here was verified by breaking the code on purpose and confirming the
tests fail — and fail *narrowly*:

| Reintroduced bug | Expected result | Observed |
|---|---|---|
| Nested locale key | i18n suite fails | 2 of 5 fail |
| `catch { return false }` in `ToolProbe` | Triage tests fail, nothing else | exactly 4 fail |

A test suite that has never been seen to fail is decoration. Anything added here
should come with the same check.

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

In priority order, driven by what has actually broken rather than by what is
easy to test:

1. **Approval gate** — [`approvalGateService.ts`](../src/application/services/approvalGateService.ts)
   and the rules in `.claudio/auto-approve.json`. It is the only thing standing
   between a model and `write` / `edit` / `bash`, and nothing downstream would
   report a bug in it.
2. **Translators** — request, response, and the SSE state machine in
   [`streamTranslator.ts`](../src/application/streamTranslator.ts). Both surfaces
   cross this path on every single request.
3. **`ToolManager`** — scoring, `UseTool` overflow, promotion decay.

The agent loops and the workspace actions sit behind these deliberately: they are
the largest surface but also the one where a live-backend snapshot still catches
most regressions.

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
