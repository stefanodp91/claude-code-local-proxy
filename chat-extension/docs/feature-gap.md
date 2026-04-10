# Feature Gap — Claudio vs. Claude Code

> Stato verificato delle funzionalità della chat-extension (Claudio) rispetto a Claude Code CLI di Anthropic, con riferimenti puntuali al codice. Questo documento è il punto di partenza per chi vuole portare Claudio a parità funzionale con Claude Code.

> **Nota di scopo**: Claudio non è un porting "uno-a-uno" di Claude Code. È un client VS Code per il proxy Anthropic↔OpenAI che gira sopra modelli LLM locali. Tuttavia diverse feature di Claude Code sono fattibili anche con modelli locali, e questo documento traccia quali sono già presenti, quali mancano, e dove la logica vive (Claudio stesso o il proxy condiviso).

> **Aggiornare questo documento** ogni volta che una feature viene implementata o lo stato cambia. Riflette il codice al momento della scrittura.

---

## 1. Architettura: dove vive cosa

Claudio è composto da tre superfici, ma non tutte le feature "agentiche" vivono dentro la chat-extension. Molte sono nel **proxy**, condiviso tra Claudio e Claude Code CLI:

```
┌─────────────┐         ┌────────┐         ┌───────────┐
│   Claudio   │────────>│  Proxy │────────>│  LM Studio│
│ (chat-ext.) │         │        │         │  (Qwen,   │
│             │         │        │         │  Nemotron)│
└─────────────┘         └────────┘         └───────────┘
   webview UI            agent loop          local LLM
   message-protocol      tool-management
   slash dispatch        slash interception
                         system prompt injection
```

Questo significa che alcune feature "mancanti dalla chat-extension" sono in realtà **già implementate nel proxy** ma non sfruttate, o sfruttate solo parzialmente, dalla chat-extension. Vedi la tabella sotto.

---

## 2. Cose già PRESENTI (alcune erroneamente date per assenti in passato)

| Feature | Dove vive | Evidenza |
|---|---|---|
| **Agent loop nativo** | Proxy | [server.ts:367-444](../../proxy/src/infrastructure/server.ts#L367-L444) — `runAgentLoop()` itera fino a 10 volte con il tool `workspace` (action `list`/`read`). Si attiva quando `maxTools > 0 && workspaceCwd` ([server.ts:272](../../proxy/src/infrastructure/server.ts#L272)). Documentato in [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md). Per Nemotron@4bit (con `maxTools=32`) è attivo; per Qwen 3.5 35B (`maxTools=0`) è spento. |
| **Auto-loaded project context** | Proxy | [server.ts:234-250](../../proxy/src/infrastructure/server.ts#L234-L250) inietta automaticamente nel system prompt: per modelli con tool nativi solo `Working directory: <cwd>`, per modelli senza tool il pieno `buildWorkspaceContextSummary()` (dir listing + package.json + primi 2000 char di README). Documentato in [proxy/docs/system-prompt-injection.md](../../proxy/docs/system-prompt-injection.md). Funzionalmente equivalente al loading di un file di progetto, anche se non c'è un file `.claudio/...` dedicato. |
| **Thinking blocks in streaming** | Proxy + Claudio | [server.ts:209-210](../../proxy/src/infrastructure/server.ts#L209-L210) attiva il flag, [streamTranslator.ts:307-354](../../proxy/src/application/streamTranslator.ts#L307-L354) converte `reasoning_content` OpenAI in blocchi `thinking` Anthropic, [proxy-client.ts:54-56](../src/extension/proxy/proxy-client.ts#L54-L56) lo abilita lato client. Visibile come pannello espandibile nella chat. |
| **Tool probe & dynamic management** | Proxy | `toolProbe.ts` fa binary search del `maxTools` del modello locale; `toolManager.ts` fa selezione dinamica con scoring + meta-tool `UseTool` per overflow; cache in `proxy/model-cache.json`. Documentato in [proxy/docs/tool-management.md](../../proxy/docs/tool-management.md). |
| **Slash command rich** | Proxy + Claudio | [slashCommandInterceptor.ts](../../proxy/src/application/slashCommandInterceptor.ts) gestisce 13 comandi proxy-side (`/status`, `/version`, `/commit`, `/diff`, `/review`, `/compact`, `/brief`, `/plan`, ecc.); [chat-session.ts:347-403](../src/extension/chat-session.ts#L347-L403) gestisce i comandi client-side (`/files`, `/copy`, `/branch`, `/commit-push-pr`, ecc.). Documentato in [slash-commands.md](slash-commands.md). |
| **Session persistence (parziale)** | Claudio webview | [message-store.service.ts:223-232](../src/webview-ui/src/app/core/services/message-store.service.ts#L223-L232) usa `vscodeApi.setState`. **Funziona solo nel ciclo di vita della webview**: collapse del sidebar e reload di VS Code resettano la cronologia. Vedi sezione "QUASI ASSENTE" sotto. |

---

## 3. Cose CONFERMATE ASSENTI o limitate

| Feature | Stato | Evidenza |
|---|---|---|
| **Tool ricchi** (Write, Edit, Bash, Grep, Glob) | ASSENTI | Il `WORKSPACE_TOOL_DEF` espone solo `list` e `read` ([workspaceTool.ts:21-42](../../proxy/src/application/workspaceTool.ts#L21-L42)). Indipendente dal modello caricato. |
| **Streaming durante agent loop nativo** | ROTTO | [server.ts:393-398](../../proxy/src/infrastructure/server.ts#L393-L398) — `runAgentLoop` invia `stream: false` ad ogni iterazione e poi emette SSE sintetico finale ([server.ts:419-421](../../proxy/src/infrastructure/server.ts#L419-L421)). Per modelli con tool nativi attivi, l'utente vede silenzio fino a fine loop. |
| **Context compaction automatica** | ASSENTE | Nessun token counting in Claudio o nel proxy. Il `conversation[]` ([chat-session.ts:131](../src/extension/chat-session.ts#L131)) cresce unbounded. Il `/compact` proxy-side è solo un enrich-prompt manuale, non automatico. |
| **Memory cross-session** | ASSENTE | Nessun `MEMORY.md` o equivalente persistente. L'unico stato cross-request lato proxy è la `promoted` map del ToolManager, in-memory e resettata al restart. |
| **Permission system** | ASSENTE | Nessuna conferma per-tool, nessun allowlist. Oggi accettabile perché tutte le action sono read-only. Quando saranno aggiunte write/bash diventerà bloccante — vedi [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md) per il design. |
| **Plan mode** | ASSENTE | Nessun mode toggle. Lo `/plan` proxy-side è solo un enrich-prompt ("think step by step"), non una vera modalità con tool gating. |
| **Hooks** | ASSENTI | Nessun sistema di hook event-driven (`pre-tool-use`, `post-tool-use`, ecc.). |
| **Skills** | ASSENTI | I slash command sono hardcoded nei due file sopra, non markdown-defined caricati a runtime. |
| **MCP (Model Context Protocol)** | ASSENTE | Nessun MCP client né nel proxy né in Claudio. |
| **Sub-agents** | ASSENTI | Nessuno spawn di agenti indipendenti. |
| **TodoWrite / task tracking** | ASSENTE | Nessuna gestione strutturata di task list integrata. |
| **Web tools** (WebFetch, WebSearch) | ASSENTI | Non implementati. |
| **Worktree isolation** | ASSENTE | Nessun codice di git worktree spawn. |
| **Session persistence reale** | QUASI ASSENTE | Verificato: la `vscodeApi.setState` funziona, ma [sidebar-provider.ts](../src/extension/webview/sidebar-provider.ts) **non setta `retainContextWhenHidden`**, e in [chat-session.ts:213-224](../src/extension/chat-session.ts#L213-L224) sull'`attachView` l'extension **sovrascrive** la history del webview con la `conversation[]` in-memory dell'extension. Risultato: collapse sidebar → history persa; reload VS Code → history persa. Il codice di persistenza esiste ma è praticamente inerte. |
| **Visualizzazione blocchi `tool_use` in streaming** | ASSENTE | [chat-session.ts:295-321](../src/extension/chat-session.ts#L295-L321) gestisce solo `text_delta`. I blocchi `tool_use` Anthropic in arrivo dal proxy sono ignorati silenziosamente. Anche quando l'agent loop nativo del proxy esegue `workspace.list()` e `workspace.read()`, l'utente in Claudio non vede nessuna indicazione visiva del tool in corso. |

---

## 4. Cosa il modello può fare oggi (matrice modello-dipendente)

Il comportamento di Claudio dipende da quale modello è caricato in LM Studio e dal `maxTools` rilevato dal probe:

| Capability | Modelli con tool nativi (es. Nemotron@4bit, `maxTools=32`) | Modelli senza tool (es. Qwen 3.5 35B, `maxTools=0`) |
|---|---|---|
| Lettura on-demand di file workspace | ✅ via `runAgentLoop` (workspace tool: list/read) | ❌ ha solo il summary statico iniettato nel prompt |
| Scrittura / edit / shell | ❌ tool non implementato (in entrambi i casi) | ❌ tool non implementato |
| Grep / glob | ❌ tool non implementato | ❌ tool non implementato |
| Streaming dei token finali | ❌ rotto durante il loop nativo | ✅ funziona normalmente (loop disattivato) |
| Streaming dei thinking | ❌ rotto durante il loop nativo | ✅ funziona normalmente |

L'incongruenza più visibile è il punto streaming: con un modello che supporta tool, l'esperienza utente è **peggiore** durante la fase agentica (silenzio prolungato) rispetto a un modello senza tool che semplicemente "stream"a thinking + risposta.

---

## 5. Cosa manca davvero per essere un "junior agent" stabile

Indipendentemente dal modello caricato, i punti che bloccano l'utilità reale di Claudio come agente sono:

1. **Set di action ricche**: read/list/grep/glob/write/edit/bash. Oggi solo read/list.
2. **Esposizione delle action model-agnostic**: serve un meccanismo che funzioni sia per modelli con `maxTools > 0` (tool calling nativo) sia per `maxTools == 0` (tool emulation tramite parsing testuale). Vedi il piano in [proxy/docs/agent-loop.md § Planned](../../proxy/docs/agent-loop.md#planned-model-agnostic-dual-path-architecture).
3. **Streaming dei token visibile durante l'agent loop**: nessun gap di silenzio per l'utente.
4. **Permission gate** per le action distruttive (write/bash) condiviso tra i path agentici. Vedi [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md).
5. **Visualizzazione lato client dei blocchi tool_use** in streaming, così l'utente vede in tempo reale "📂 list .", "📄 read README.md", "🔍 grep parseConfig", ecc.

I punti 1-4 sono lavoro **lato proxy**. Il punto 5 è lavoro **lato Claudio** (parsing dei `content_block` `tool_use`/`tool_result` nel `chat-session.ts` e nel webview).

Tutto il resto (skills, MCP, hooks, plan mode, sub-agents, todo, web tool, memory cross-session, plan mode) è importante per la "parità completa" con Claude Code, ma è secondario rispetto ai punti 1-5.

---

## 6. Roadmap di alto livello

Per chiudere il gap minimo per "junior agent":

1. **Shared action backend** lato proxy: nuovo file `proxy/src/infrastructure/workspaceActions.ts` con read/list/grep/glob/write/edit/bash, validazione path, timeout, truncation.
2. **Path A**: refactor di `runAgentLoop` per fare streaming reale durante le iterazioni e per gestire le nuove action.
3. **Path B**: nuovo `runTextualAgentLoop` per i modelli con `maxTools == 0`, basato su parsing di tag XML inline emessi dal modello in plain text.
4. **Output normalization**: entrambi i path producono SSE Anthropic standard verso il client. Claudio non sa quale path è in uso.
5. **Visualizzazione tool_use**: estensione di `chat-session.ts` e nuovo componente Angular per mostrare i blocchi `tool_use` in chat man mano che arrivano.
6. **Permission gate**: evento custom SSE `tool_request_pending` + endpoint `POST /v1/messages/:id/approve` + modal Angular di conferma.
7. **Update di questo documento** dopo ogni step.

L'architettura completa di destinazione è in [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md).

---

## Documenti correlati

- [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md) — agent loop attuale e roadmap dual-path
- [proxy/docs/system-prompt-injection.md](../../proxy/docs/system-prompt-injection.md) — context auto-loading nel system prompt
- [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md) — permission gate planned
- [proxy/docs/tool-management.md](../../proxy/docs/tool-management.md) — probe + scoring + UseTool
- [architecture.md](architecture.md) — struttura interna di Claudio
