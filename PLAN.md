# Piano di evoluzione

> Stato del progetto e percorso per riprenderlo in mano.
> Ultimo aggiornamento: 2026-08-26.

---

## 1. Cos'è questo repository

Tre cose distinte, in un solo repo:

| Componente | Cosa | Dimensione | Ruolo |
|---|---|---|---|
| [`claude_code/src/`](claude_code/src/) | Sorgente leaked di Claude Code CLI (2026-03-31) | 1.902 file, 33 MB | Archivio di riferimento. Mai modificato, mai importato dal resto |
| [`proxy/`](proxy/) | Proxy di traduzione Anthropic → OpenAI | ~7.800 righe TS, 46 file | **Il cuore del progetto** |
| [`chat-extension/`](chat-extension/) | "Claudio", estensione VS Code | 2.074 righe host + 3.887 webview Angular 19 | Superficie primaria |

Il valore vero è nel proxy: architettura esagonale con porte e adapter, e **zero
dipendenze runtime** — solo built-in Node. Questa proprietà va difesa: rende il
codice testabile senza mock framework e il deploy banale.

### Due superfici, due comportamenti del proxy

La distinzione decide tutto, e non è documentata da nessun'altra parte:

```
Claudio  ──[X-Workspace-Root]──>  proxy  ──>  LM Studio
                                    └─ esegue il PROPRIO agent loop
                                       (workspace tool, permission gate,
                                        plan mode, python executor)

CLI      ──[nessun header]──────>  proxy  ──>  LM Studio
                                    └─ puro traduttore: la CLI tiene
                                       il suo loop, i suoi ~40 tool,
                                       i suoi prompt di permesso
```

Il routing è in [`handleChatMessageUseCase.ts`](proxy/src/application/useCases/handleChatMessageUseCase.ts),
dentro `if (workspaceCwd)`. Circa 3.000 delle 7.800 righe del proxy servono solo
Claudio. Vederlo chiaramente è ciò che rende sensate le priorità qui sotto.

---

## 2. Il modello attuale, misurato

`qwen/qwen3.8-27b` su LM Studio — **MLX 4-bit** (l'id non lo lascia intendere),
`arch: qwen3_5`, `type: vlm`, contesto caricato **119.552** token su 262.144 max.

Misure dirette del 2026-08-26:

| Cosa | Risultato |
|---|---|
| Tool calling strutturato | funziona, con la scelta del tool giusta |
| Tetto tool reale | **≥ 96** (nessun fallimento trovato) |
| Tetto riportato dal probe | 64 = `PROBE_UPPER_BOUND`, non un limite del modello |
| `reasoning_content` | **sempre emesso**, non sopprimibile |
| Iterazioni d'agente | 40, il tier massimo (contesto ≥ 64K) |
| Compaction | scatta a ~95.600 token |

Sul thinking non funziona nessuno dei tre interruttori: `enable_thinking`
top-level (quello che il proxy manda), `chat_template_kwargs.enable_thinking`,
né il soft switch Qwen `/no_think`. Quindi `thinkingCanBeDisabled: false` in
`model-cache.json` **è la risposta corretta**, non un bug.

> **Non estrapolare tra modelli.** Il tetto dei tool e il comportamento del
> thinking dipendono da architettura, chat template e da come il backend fa il
> parsing di *quel* modello. Numeri visti su nemotron o gemma non dicono nulla su
> un modello nuovo. L'autorità è il probe — il codice lo dice già a
> [`server.ts:349`](proxy/src/infrastructure/server.ts#L349).

---

## 3. Fase 0 — fatta

Otto commit sul branch `fase-0-cleanup`. Entrambi i typecheck puliti, suite verde.

- **`fix(proxy)`** — Il probe leggeva i timeout come limiti di capacità.
  `catch { return false }` rendeva timeout, errore di rete e "il modello non ha
  prodotto tool_calls" lo stesso risultato. Siccome più tool = risposta più
  lenta, i timeout si addensavano **esattamente sul confine cercato**: il probe
  misurava latenza. Riportava 47 su un modello che ne regge ≥96. Ora ogni
  tentativo è `tool_calls` / `no_tool_calls` / `inconclusive`, gli inconclusivi
  si ritentano a timeout triplo, e la riga finale dichiara la propria
  affidabilità. `PROBE_UPPER_BOUND` 32→64, `PROBE_TIMEOUT` 30s→60s.
- **`feat(proxy)`** — Guard: richiesta con tool + `maxTools == 0` + nessun
  header → HTTP 400 leggibile, invece di 40 tool sparati a un modello che ha
  fallito il probe con uno solo.
- **`fix(claudio)`** — L'unico errore di typecheck del repo, e sotto di esso la
  mutua esclusività delle viste che non era mai avvenuta.
- **`docs`** — Versioni, startup, e quattro auto-contraddizioni di
  `feature-gap.md`.
- **`test(proxy)`** — Prima suite automatica del repository: `node:test`, 13
  test, ~160 ms, senza GPU. Vedi la Fase 1 qui sotto.
- **`ci`** — [`ci.yml`](.github/workflows/ci.yml): typecheck e test su ogni push
  e ogni PR. È il commit che rende i test una barriera invece che un'abitudine.
- **`docs`** (secondo giro) — `proxy/README.md` descriveva ancora un server Bun
  a file singolo con `start.sh` e `start_claude_code.sh`: requisiti, quick start,
  script e struttura file riscritti sul codice reale. Nuovo
  [`proxy/docs/testing.md`](proxy/docs/testing.md), tre doc del proxy che non
  erano linkate da nessun indice, gli anchor di riga di `feature-gap.md`
  ricalcolati, e il docstring di `nativeAgentLoopService.ts` che contraddiceva
  il proprio codice sullo streaming di iter-0.

---

## 4. Fase 1 — rete di sicurezza  ← **in corso**

**Il punto di partenza era zero test e zero CI.** L'unico strumento era
[`proxy/scripts/regression.sh`](proxy/scripts/regression.sh), uno snapshot via
curl che richiede proxy + LM Studio + un modello caricato: non gira in CI, non
gira senza GPU accesa. Oggi l'infrastruttura c'è ed è verde — 13 test su i18n e
`ToolProbe`, eseguiti a ogni push — ma **la copertura è ancora agli inizi**: il
gate di approvazione, i traduttori e `ToolManager` non sono coperti, ed è lì che
la fase si chiude davvero.

Questa è la fase che sblocca tutto il resto. Senza, ogni modifica successiva è
una scommessa — e la Fase 0 ha prodotto due prove dirette del perché:

1. Il bug del probe è sopravvissuto perché nulla verificava che un timeout e un
   rifiuto del modello fossero cose diverse.
2. Aggiungendo la chiave di traduzione del guard ho quasi introdotto un bug io:
   l'avevo scritta annidata, ma `t()` usa una mappa **piatta**
   (`Record<string, string>`), quindi il messaggio d'errore sarebbe uscito come
   stringa grezza `tools.unsupportedByModel`. TypeScript non lo vede, perché
   `JSON.parse` restituisce `any`.

### Ordine di attacco

Guidato da ciò che si è davvero rotto, non da ciò che è facile da testare.

1. ~~**Chiavi i18n**~~ — **fatto.** [`test/i18n.test.ts`](proxy/test/i18n.test.ts):
   ogni chiave passata a `t()` esiste in ogni locale, ogni locale è una mappa
   *piatta* di stringhe, e i locale non divergono tra loro. Verificato per
   negativo: reintroducendo la chiave annidata, 2 test su 5 falliscono.
2. ~~**`ToolProbe`**~~ — **fatto.** [`test/toolProbe.test.ts`](proxy/test/toolProbe.test.ts):
   8 test sul triage degli esiti, incluso un caso di regressione che riproduce
   la traccia reale (n=48 lento → il vecchio codice riportava 47). Verificato
   per negativo: ripristinando `catch { return false }` falliscono esattamente
   i 4 test del triage, e la regressione stampa `actual: 47`.
3. **Approval gate**  ← **prossimo** — [`approvalGateService.ts`](proxy/src/application/services/approvalGateService.ts)
   e le regole di `.claudio/auto-approve.json`. È l'unico controllo su
   `write` / `edit` / `bash`; un bug qui non lo segnala nessuno a valle.
4. **Traduttori** — request, response, e la macchina a stati SSE di
   [`streamTranslator.ts`](proxy/src/application/streamTranslator.ts). È il
   percorso che *entrambe* le superfici attraversano sempre.
5. **`ToolManager`** — scoring, overflow `UseTool`, decadimento delle
   promozioni.

**Infrastruttura** — in piedi. `node:test` (built-in, zero dipendenze nuove:
`dependencies` resta `{}`), test in `proxy/test/`, inclusi nel typecheck.
`npm test` in 13 test / ~160 ms, senza GPU e senza rete.

`LlmClientPort` e `SseWriterPort` sono già porte, quindi fake-abili senza mock
framework — l'architettura esagonale è già pagata, va solo usata. `ToolProbe`
invece usa `fetch` globale, e il test lo stubba: se un domani diventasse una
porta, il test si semplificherebbe da solo.

**CI** — [`.github/workflows/ci.yml`](.github/workflows/ci.yml): typecheck +
test del proxy, typecheck dell'estensione. Nessuna GPU, ed è il motivo per cui
`regression.sh` non copre questa esigenza e non va confuso con essa.

> Uno script `pretest` fallisce se il glob non matcha nulla. Serve: `node --test`
> **esce 0 quando non trova test**, quindi un glob rotto o un Node senza il
> supporto avrebbero prodotto una build verde che non ha verificato niente — lo
> stesso schema di fallimento silenzioso che il progetto ha già mostrato tre volte.

---

## 5. Fase 2 — correttezza nota

Tre problemi già identificati e circoscritti, da affrontare *dopo* i test.

- **Compaction assente dentro il loop.** Scatta solo sulla richiesta in
  ingresso ([`handleChatMessageUseCase.ts:276`](proxy/src/application/useCases/handleChatMessageUseCase.ts#L276)).
  Dentro il loop ogni iterazione fa `messages.push()` senza ricontrollare il
  budget: con 40 iterazioni e `read` che tronca a 50 KB, un turno lungo può
  saturare il contesto a metà. È il gap più affilato rimasto.
- **Path B è di serie B.** `MAX_ITERATIONS = 10` hardcoded a
  [`textualAgentLoop.ts:85`](proxy/src/application/textualAgentLoop.ts#L85),
  mentre il CHANGELOG 1.3.0 dichiara che il limite configurabile "replaces the
  hardcoded limit of 10" — è arrivato solo in Path A. Manca anche il dispatch
  parallelo delle azioni read-only. Con un modello che supporta i tool, Path B
  è un fallback: **non serve portarlo alla pari, serve che smetta di mentire** e
  sia marcato come degradato.
- **`bash` blocca l'event loop** fino a 30s (`spawnSync` in
  [`workspaceActions.ts`](proxy/src/infrastructure/workspaceActions.ts)).
  Accettabile per un proxy locale monoutente; da sapere, non da correggere ora.

---

## 6. Fase 3 — feature

In ordine di valore su un modello locale, non di parità con Claude Code.

1. **Memoria cross-sessione.** Miglior rapporto valore/costo: un `MEMORY.md`
   letto dal `SystemPromptBuilder`, che è già l'unico punto di iniezione.
2. **Verificare il percorso immagini.** Il modello ora è `type: "vlm"` e la
   traduzione dei blocchi immagine → `image_url` esiste già a
   [`requestTranslator.ts:202`](proxy/src/application/requestTranslator.ts#L202).
   Claudio permette già di allegare immagini. Potrebbe funzionare end-to-end
   senza scrivere niente: va solo provato.
3. Il resto (hooks, skills, MCP, sub-agent, TodoWrite, web tools, worktree) è
   parità con Claude Code, costoso e di resa modesta su un 27B locale.

---

## 7. Decisioni aperte

- **`claude_code/` è zavorra o archivio?** 1.902 file e 33 MB tracciati in git,
  mai toccati, mai importati. Se il progetto da far vivere è il proxy, pesa su
  ogni clone e ogni ricerca. Dipende se il repo è "l'archivio del leak, con in
  più un proxy" o "il mio proxy, con in più un archivio".
- **Fino a dove seguire la CLI?** Claudio è la superficie primaria, ma la CLI
  funziona e ora ha i tool nativi interi. Ogni feature va decisa sapendo quale
  delle due serve.

---

## 8. Cosa questo progetto ha insegnato su sé stesso

Tre schemi ricorrenti, utili a chi riprende in mano il codice:

- **La documentazione è stata scritta in anticipo sul codice**, e il codice non
  l'ha raggiunta. Senza test, i doc erano l'unica specifica — per questo la
  deriva contava più di quanto sembri. Quando doc e codice divergono, **il
  codice ha ragione**, ma la deriva va corretta, non ignorata.
- **I fallimenti silenziosi sono il modo di rompersi tipico di qui.** Il probe
  che confonde timeout e incapacità, i 40 tool spediti a un modello che non ne
  regge uno, la chiave i18n annidata che stampa sé stessa, il dispose mai
  chiamato. Nessuno di questi solleva un errore. Il lavoro utile è quasi sempre
  *rendere rumoroso ciò che oggi tace*.
- **Misurare, non dedurre.** Le capacità dei modelli non si trasferiscono tra
  modelli, e i metadata dichiarati dal backend non sono affidabili. Il codice lo
  sapeva già; il modo di lavorare deve saperlo altrettanto.
