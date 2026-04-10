# Slash Commands — Full Reference

> All commands available in Claudio, how they work, and who handles them.

---

## How they work

Type `/` in the text box at the bottom of the Claudio panel. An autocomplete menu appears with the available commands. Select a command with the arrow keys and press Enter (or click it).

---

## Handler types

Slash commands are handled by two different actors:

| Handler | Who executes | How it works |
|---------|-------------|--------------|
| **proxy** | The proxy server | The message is sent to the proxy, which intercepts it *before* calling the LLM. It can respond immediately (synthetic) or enrich the message with context (enrich) and then call the LLM. |
| **client** | The VS Code extension host | The command is executed locally in the extension host. It is never sent to the proxy or the LLM. |

---

## Proxy-handled commands

These commands are sent to the proxy, which intercepts them before any LLM call.

### `/status`

**Shows the current proxy status.**

```
Example response:
## Proxy Status
- **Proxy version:** 1.1.0
- **Target URL:** http://127.0.0.1:1234/v1/chat/completions
- **Port:** 5678
- **Node.js:** v20.11.0
- **Working dir:** /Users/you/myproject
```

- **Handler:** proxy
- **Result type:** synthetic (immediate response, no LLM call)
- **Prerequisites:** none

---

### `/version`

**Shows the proxy package version.**

```
Example response:
**Anthropic-to-OpenAI Proxy** v1.1.0
```

- **Handler:** proxy
- **Result type:** synthetic
- **Prerequisites:** none

---

### `/commit`

**Reads the staged diff and recent commits, then asks the LLM to write a commit message.**

How it works:
1. Runs `git diff --staged` in the workspace directory
2. Runs `git log --oneline -5`
3. Sends the diff + recent commits to the LLM with a request to write a conventional commit message

```
Example prompt sent to the LLM:
Staged diff:
```diff
+ console.log("hello")
```

Recent commits:
```
abc123 feat: add logging
```

Write a concise conventional commit message for these changes.
```

- **Handler:** proxy
- **Result type:** enrich → LLM writes the commit message
- **Prerequisites:** files must be staged (`git add <file>`)
- **Response if nothing staged:** "No staged changes. Run `git add <file>` first."

---

### `/diff`

**Reads all uncommitted changes and asks the LLM to explain them.**

How it works:
1. Runs `git diff HEAD` in the workspace directory
2. Sends the diff to the LLM with a request to explain the changes clearly and concisely

- **Handler:** proxy
- **Result type:** enrich → LLM explains the changes
- **Prerequisites:** git repository with uncommitted changes
- **Response if no changes:** "No uncommitted changes found."

---

### `/review`

**Reads the diff against the main/master branch and asks the LLM to do a code review.**

How it works:
1. Tries `git diff main...HEAD`, falls back to `git diff master...HEAD`
2. Sends the diff to the LLM with a request to identify issues and suggest improvements

- **Handler:** proxy
- **Result type:** enrich → LLM does code review
- **Prerequisites:** git repository with a main or master branch
- **Response if no diff:** "No changes found vs main/master branch."

---

### `/compact`

**Asks the LLM to summarize the current conversation.**

The proxy replaces the last message with: *"Summarize our conversation so far in one concise paragraph, capturing the key points and decisions."*

Useful when the conversation has become long and you want to condense the context.

- **Handler:** proxy
- **Result type:** enrich → LLM summarizes
- **Prerequisites:** none (works even on short conversations)

---

### `/brief`

**Asks the LLM to respond briefly in subsequent replies.**

The proxy replaces the last message with: *"From now on in this conversation, respond briefly — maximum 3 sentences per answer unless explicitly asked for more detail."*

- **Handler:** proxy
- **Result type:** enrich → LLM responds briefly
- **Prerequisites:** none

---

### `/plan`

**Asks the LLM to reason step-by-step before responding.**

The proxy replaces the last message with: *"Think step by step before giving your next answer. Show your reasoning process."*

- **Handler:** proxy
- **Result type:** enrich → LLM shows its reasoning
- **Prerequisites:** none

---

## Client-handled commands (extension host)

These commands are executed locally by the VS Code extension host. They are never sent to the proxy or the LLM.

### `/files`

**Lists the files open in the workspace and lets you ask the LLM about them.**

How it works:
1. Reads the list of files open in the VS Code editor
2. Sends the list as a response to the panel
3. You can select one or more files to discuss further

- **Handler:** client
- **Prerequisites:** workspace open in VS Code

---

### `/simplify`

**Sends the active editor file's content to the LLM and asks for simplification suggestions.**

How it works:
1. Reads the content of the file open in the active editor
2. Attaches it to the next message with a code review request

- **Handler:** client
- **Prerequisites:** a file open in the VS Code editor

---

### `/copy`

**Copies the last LLM response to the system clipboard.**

- **Handler:** client
- **Prerequisites:** at least one response in the history

---

### `/branch`

**Opens an integrated VS Code terminal with the `git checkout -b ` command ready.**

You need to complete the branch name and press Enter.

- **Handler:** client
- **Prerequisites:** VS Code terminal available, git repository

---

### `/commit-push-pr`

**Opens a terminal with a pre-filled flow for commit → push → PR creation.**

Requires the GitHub CLI (`gh`) to be installed and authenticated.

- **Handler:** client
- **Prerequisites:** `gh` CLI installed (`brew install gh` / `winget install GitHub.cli`), authenticated with `gh auth login`

---

### `/pr-comments`

**Opens a terminal with `gh pr view --comments` to see comments on the current PR.**

- **Handler:** client
- **Prerequisites:** `gh` CLI installed and authenticated, PR open for the current branch

---

### `/clear`

**Clears the entire conversation history.**

Warning: the action is irreversible. The conversation starts over from scratch.

- **Handler:** client
- **Prerequisites:** none

---

## Summary table

| Command | Handler | Result type | Prerequisites |
|---------|---------|-------------|--------------|
| `/status` | proxy | synthetic | — |
| `/version` | proxy | synthetic | — |
| `/commit` | proxy | enrich → LLM | `git add` run first |
| `/diff` | proxy | enrich → LLM | Uncommitted changes |
| `/review` | proxy | enrich → LLM | main/master branch |
| `/compact` | proxy | enrich → LLM | — |
| `/brief` | proxy | enrich → LLM | — |
| `/plan` | proxy | enrich → LLM | — |
| `/files` | client | immediate response | Workspace in VS Code |
| `/simplify` | client | attachment → LLM | File open in editor |
| `/copy` | client | clipboard | At least 1 response |
| `/branch` | client | opens terminal | Git repository |
| `/commit-push-pr` | client | opens terminal | `gh` CLI |
| `/pr-comments` | client | opens terminal | `gh` CLI, PR open |
| `/clear` | client | clears history | — |

---

## Blocked Anthropic commands

The following commands are specific to Anthropic/Claude.ai and are not available with local LLMs. Typing them shows an explanatory message without calling the LLM:

`/login`, `/logout`, `/upgrade`, `/usage`, `/cost`, `/feedback`, `/mobile`, `/desktop`, `/session`, `/share`, `/rate-limit-options`, `/privacy-settings`, `/install-github-app`, `/install-slack-app`, `/chrome`, `/teleport`, `/heapdump`, `/web-setup`

---

## Adding custom commands

To add a new slash command:

**Proxy commands** (server-side logic):
1. Add an entry to `SLASH_COMMAND_REGISTRY` in [proxy/src/application/slashCommandInterceptor.ts](../../proxy/src/application/slashCommandInterceptor.ts) with `handler: "proxy"`
2. Add a `case` in the `execute()` method of the same class
3. Restart the proxy

**Client commands** (extension host logic):
1. Add an entry to `SLASH_COMMAND_REGISTRY` in [proxy/src/application/slashCommandInterceptor.ts](../../proxy/src/application/slashCommandInterceptor.ts) with `handler: "client"`
2. Add the handler in `handleClientSlashCommand()` in [chat-extension/src/extension/chat-session.ts](../src/extension/chat-session.ts)
3. Rebuild the extension: `npm run build && npm run package && code --install-extension claudio-0.1.0.vsix`

---

## Related Docs

- [Quick Start](quick-start.md) — Claudio installation
- [Architecture](architecture.md) — how it works internally
- [Proxy Architecture — Slash Command Interception](../../proxy/docs/architecture.md#slash-command-interception) — proxy-side details
