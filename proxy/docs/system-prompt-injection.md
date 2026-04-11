# System Prompt Injection

> How the proxy constructs the system prompt for every workspace-aware request, and why this logic is centralized in the application layer behind a port.

## Overview

When a client sends `POST /v1/messages` with the `X-Workspace-Root` header, the proxy builds a complete system prompt **before** forwarding the request to the local LLM. The goal is threefold:

1. **Tell the model where it is** — give it the workspace path so references to "the project" have grounding.
2. **Tell the model what it can do** — in ask/auto modes, instruct it to call the `workspace` tool rather than explain commands in markdown.
3. **Guide its behaviour in Plan mode** — inject a forced directive ("you are in Plan mode, write to `<plansDir>/<slug>.md`") and the content of any existing plan file so follow-up requests refine the same plan instead of spawning new ones.

The injection adapts to (a) the current `agentMode`, (b) whether the model supports native tool calls, and (c) whether a plan file already exists in the workspace.

---

## Where It Happens

The injection is implemented by **[`SystemPromptBuilder`](../src/application/services/systemPromptBuilder.ts)**, an application-layer service wired in `ProxyServer.handleMessages`. The service depends only on two ports:

- [`PromptRepositoryPort`](../src/domain/ports/promptRepositoryPort.ts) — loads the localized prompt templates.
- [`PlanFileRepositoryPort`](../src/domain/ports/planFileRepositoryPort.ts) — exposes `isPlanPath()` and `loadMostRecent()`; it is the single source of truth for where plan files live.

`SystemPromptBuilder` does not touch the filesystem, `fetch`, or any global state. It can be unit-tested by substituting the two ports with in-memory fakes.

### Composition root

In `ProxyServer`'s constructor ([server.ts](../src/infrastructure/server.ts)):

```typescript
const clock = new SystemClock();
this.planFiles     = new FsPlanFileRepository(config.plansDir, clock);
this.promptRepo    = new FsPromptRepository(config.locale);
this.promptBuilder = new SystemPromptBuilder(this.promptRepo, this.planFiles);
```

The concrete adapters (`FsPlanFileRepository`, `FsPromptRepository`, `SystemClock`) live in `infrastructure/adapters/`. `ProxyServer` is the only place that creates them; every other consumer sees the ports.

At boot, `ProxyServer.initialize()` calls `await this.promptRepo.load()`, which reads all prompt templates from `proxy/prompts/<locale>/` once. Subsequent requests hit the in-memory map — no filesystem traffic on the hot path.

---

## Prompt Templates

Long LLM prompts live as `.md` files under `proxy/prompts/<locale>/`. This keeps them diff-friendly, editable without recompiling, and localizable. The current set:

| File | Purpose |
|---|---|
| [`agent-base.md`](../prompts/en_US/agent-base.md) | Instructions for ask/auto modes — tells the model to CALL the `workspace` tool rather than explain commands. |
| [`plan-mode.md`](../prompts/en_US/plan-mode.md) | Forced Plan-mode directive — mandatory write to `<plansDir>/<slug>.md`, forbidden behaviors, and the `exit_plan_mode` control action. |
| [`existing-plan-section.md`](../prompts/en_US/existing-plan-section.md) | Template injected into `plan-mode.md` when an existing plan is found, so the model refines the same file instead of spawning a new one. |

### Templating

Templates use `{{name}}` placeholders — the same syntax as `domain/i18n.ts`. The builder passes a parameter map to `PromptRepositoryPort.get(key, params)`:

| Placeholder | Source | Where used |
|---|---|---|
| `{{cwd}}` | `workspaceCwd` from the request header | All prompts (final "Working directory:" line) |
| `{{cwdBase}}` | `basename(workspaceCwd)` | All prompts |
| `{{plansDir}}` | `PlanFileRepositoryPort.plansDirRelative` (from `ProxyConfig.plansDir`) | `plan-mode.md` (every mention of the plans directory) |
| `{{existingPlanSection}}` | Rendered `existing-plan-section.md` or empty string | `plan-mode.md` |
| `{{planPath}}` | `existing.relPath` | `existing-plan-section.md` |
| `{{mtimeRelative}}` | `existing.mtimeRelative` | `existing-plan-section.md` |
| `{{planContent}}` | Full content of the existing plan file | `existing-plan-section.md` |

**Key consequence**: changing `PLANS_DIR` env var (see [configuration.md](configuration.md#plan-mode)) re-routes every mention of the plans directory in the prompt — the model is told to write to the new location without any code change.

---

## The Decision Tree

```
SystemPromptBuilder.build(workspaceCwd, mode, textualPath)
│
├── mode === Plan ?
│     ├── YES → loadMostRecent(cwd) → ExistingPlan | null
│     │         ├── ExistingPlan non-null → render existing-plan-section.md
│     │         └── null → existingPlanSection = ""
│     │         render plan-mode.md with {cwd, cwdBase, plansDir, existingPlanSection}
│     │
│     └── NO  → render agent-base.md with {cwd, cwdBase, plansDir}
│
└── textualPath ?
      └── YES → append buildWorkspaceContextSummary(cwd)
                append TEXTUAL_TOOL_MANUAL
      (Path B only — models without native tool calling)
```

The `textualPath` flag is set by `ProxyServer` when `this.maxTools === 0`. On that path the model has no way to fetch workspace context later, so the builder front-loads a project snapshot and a manual for the `<action>` XML protocol.

---

## Plan-File Path Classification

Plan mode's auto-approve rule ("writes inside the plans directory are auto-approved") needs to answer "is this path a plan file?" for arbitrary `args.path` values sent by the model. That check lives in **one place**: `PlanFileRepositoryPort.isPlanPath()`, implemented by `FsPlanFileRepository`:

```typescript
isPlanPath(relPath: string): boolean {
  if (!relPath.endsWith(".md")) return false;
  const norm = relPath.replace(/\\/g, "/");
  const dir = this.plansDirRelative.replace(/\\/g, "/").replace(/\/$/, "");
  return norm.startsWith(`${dir}/`) || norm.includes(`/${dir}/`);
}
```

`ProxyServer.requestApproval` calls `this.planFiles.isPlanPath(args.path)` during the Plan-mode gate. The native agent loop's `emitPlanFileCreated` helper also delegates here. **No other code knows the plans directory path** — change `PLANS_DIR` and the whole system follows.

---

## Merging with the Client's System Prompt

The proxy is careful not to overwrite a system prompt the client may have built itself. After building its own prompt, `ProxyServer.handleMessages` merges:

| Existing `body.system` | Result |
|---|---|
| Absent / empty | `body.system = builtPrompt` (string) |
| String | `body.system = builtPrompt + "\n\n" + clientSystem` (string) |
| Array of content blocks | A new `{type: "text", text: builtPrompt}` block is **prepended** |

This preserves anything the client wanted to say while ensuring the workspace context appears first.

---

## Localization

Today only `en_US` is implemented. To add another locale:

1. Create `proxy/prompts/<locale>/agent-base.md`, `plan-mode.md`, and `existing-plan-section.md`.
2. Set `LOCALE=<locale>` in `.env.proxy`.
3. Restart the proxy. `FsPromptRepository.load()` reads the new files at boot; if any are missing it throws a clear error.

The `PromptKey` enum in `domain/ports/promptRepositoryPort.ts` is the authoritative list of required files. If you add a new key there, all locales must add the corresponding `.md` file.

---

## Related Docs

- [Configuration](configuration.md#plan-mode) — `PLANS_DIR` and `LOCALE` env vars
- [Agent Loop](agent-loop.md) — how the prompt drives the loop (native + textual paths)
- [Permission Protocol](permission-protocol.md) — how `isPlanPath` gates Plan-mode writes
- [Architecture](architecture.md) — where the builder sits in the hexagonal layout
