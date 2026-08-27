# demo-workspace

A small project that exists to be pointed at, not to be developed. It is what
[`verify-all.sh`](../verify-all.sh) tells you to open, and what the manual half
of the checks is performed against.

It contains, on purpose:

- **two source files** with no `'use strict'` and no doc comments, so there is
  something to change;
- **a skill** in `.claudio/skills/commit-style/`, whose rules are deliberately
  unguessable — a rune in the subject line, a fixed last line. A model that
  follows them can only have read them;
- **a hook** in `.claudio/hooks.json`, which complains after any `write` to a
  file missing the `'use strict'` pragma.

## Trusting the hook

Hooks run without asking, so they are inert until someone trusts the file **on
this machine**, and the trust is on its content:

```bash
cd proxy && npm run hooks -- trust ../demo-workspace
```

That is not ceremony for the demo's sake: it is the same command a person runs
for a real project, and the reason a repository you clone cannot run commands on
your machine by shipping a hooks file.

## What to ask for

Open this directory in VS Code with Claudio attached, and try these. Each one
lights up a different piece:

| Ask | Watch for |
|---|---|
| *Add a JSDoc comment above every function in `src/`, then write a README listing them* | the model writes `.claudio/TODO.md` by itself and ticks it off as it goes |
| *Write me a commit message for a fix to `slug()`* | it loads the skill: a rune in the subject, `Skål.` last |
| *Create `src/config.js` with a `loadConfig` function* | the hook complains about the missing pragma, and the model rewrites the file |
| *Delete `src/parser.js`* | the approval modal — in `ask` mode |
| *Plot y = x² with python and tell me what shape it is* | the PNG lands in `.claudio/plots/`, and the model describes a figure it is looking at |

The files here are meant to be edited by the model. Reset them with
`git checkout demo-workspace` when you want a clean run.
