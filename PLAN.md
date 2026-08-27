# Piano di evoluzione

> Stato del progetto e percorso per riprenderlo in mano.
> Ultimo aggiornamento: 2026-08-27 (fine sessione: routing coperto, shell non
> bloccante, percorso immagini provato dal vivo).
>
> **Chi riprende il lavoro parte da [CLAUDE.md](CLAUDE.md)**: mappa del repo,
> comandi per verificare, invarianti da non rompere e il metodo di lavoro.
> Questo documento è il *dove siamo e dove andiamo*; quello è il *come*.
>
> Se torni qui dopo settimane, salta a [§9 — Da dove ripartire](#9-da-dove-ripartire):
> cos'è vero oggi, cosa si può fare senza decidere niente, e cosa aspetta una tua
> decisione.

---

## 1. Cos'è questo repository

Tre cose distinte, in un solo repo:

| Componente | Cosa | Dimensione | Ruolo |
|---|---|---|---|
| [`claude_code/src/`](claude_code/src/) | Sorgente leaked di Claude Code CLI (2026-03-31) | 1.902 file, 33 MB | Archivio di riferimento. Mai modificato, mai importato dal resto |
| [`proxy/`](proxy/) | Proxy di traduzione Anthropic → OpenAI | 8.816 righe TS in 50 file, più 5.303 di test | **Il cuore del progetto** |
| [`chat-extension/`](chat-extension/) | "Claudio", estensione VS Code (63 test dal 2026-08-27) | 2.074 righe host + 3.887 webview Angular 19 | Superficie primaria |

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
                                       il suo loop, i suoi tool,
                                       i suoi prompt di permesso
```

Il routing è in [`handleChatMessageUseCase.ts`](proxy/src/application/useCases/handleChatMessageUseCase.ts),
dentro `if (workspaceCwd)`. Circa 3.570 delle 8.816 righe del proxy servono solo
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
> [`server.ts:369`](proxy/src/infrastructure/server.ts#L369).

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
- **`ci`** — [`ci.yml`](.github/workflows/ci.yml): typecheck e test del proxy e
  dell'estensione. Nato come barriera automatica su ogni push e ogni PR; oggi
  **parte solo su richiesta** (vedi §4). La barriera è tornata a essere il
  comando locale prima del commit.
- **`docs`** (secondo giro) — `proxy/README.md` descriveva ancora un server Bun
  a file singolo con `start.sh` e `start_claude_code.sh`: requisiti, quick start,
  script e struttura file riscritti sul codice reale. Nuovo
  [`proxy/docs/testing.md`](proxy/docs/testing.md), tre doc del proxy che non
  erano linkate da nessun indice, gli anchor di riga di `feature-gap.md`
  ricalcolati, e il docstring di `nativeAgentLoopService.ts` che contraddiceva
  il proprio codice sullo streaming di iter-0.

---

## 4. Fase 1 — rete di sicurezza  ← **chiusa**

**Il punto di partenza era zero test e zero CI.** L'unico strumento era
[`proxy/scripts/regression.sh`](proxy/scripts/regression.sh), uno snapshot via
curl che richiede proxy + LM Studio + un modello caricato: non gira in CI, non
gira senza GPU accesa. Oggi sono **432 test**, ~4 s, su qualunque macchina.

> **Attenzione a come si dice.** "Ogni componente ha una suite" è ciò che avevo
> scritto qui, e contando è falso: restano scoperti lo use case di routing,
> l'intercettore degli slash command, il probing di avvio e gli adapter sottili. L'elenco onesto è in
> [`testing.md`](proxy/docs/testing.md#not-covered-yet). Coperto è *tutto ciò che
> era nell'ordine d'attacco*, più i due loop, le azioni di workspace e il
> compattatore.

I sei punti dell'ordine d'attacco sono stati coperti per primi; poi i tre che
erano rimasti fuori:

| Componente | Test | Bug trovati |
|---|--:|---|
| `workspaceActions` | 34 | `edit` corrompeva le sostituzioni contenenti `$`; una slash finale nella root rifiutava *ogni* path |
| Path B (`textualAgentLoop`) | 17 | `edit` non funzionava affatto; la forma documentata di `write` veniva stampata all'utente invece di eseguita |
| Path A (`nativeAgentLoopService`) | 19 | nessuno — è il percorso esercitato ogni giorno |

**Il conto totale: nove bug reali**, e nessuno dei nove lanciava un'eccezione,
scriveva un log o falliva un typecheck. Non è una coincidenza: è *la* forma di
guasto di questo progetto, ed è la ragione per cui la fase valeva la spesa.

Quel che resta non è un componente ma tre **decisioni**, registrate nella Fase 2
invece che lasciate come buchi silenziosi. E resta il rischio che non sta dentro
nessuna unità ma *fra* di esse: è ciò per cui esiste `regression.sh`, ed è il
motivo per cui continua a meritarsi il posto.

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
3. ~~**Approval gate**~~ — **fatto.** [`test/approvalGate.test.ts`](proxy/test/approvalGate.test.ts):
   20 test sulla precedenza fra plan mode, auto mode, file fidati e allowlist, su
   quali scope persistono e quali no, e sul contenimento nel workspace. Metà
   delle asserzioni sono su *"la modale non è stata alzata"*: un gate che chiede
   troppo dà fastidio, un gate che smette di chiedere è il guasto vero e non lo
   segnala nessuno. Ha fatto emergere un bug reale — vedi sotto. Verificato per
   negativo su tre fronti: 1, 2 e 1 test falliti, esattamente quelli attesi.
4. ~~**Traduttori**~~ — **fatto.** 64 test su tre file: request (25), response
   (16) e la macchina a stati SSE (23). È il percorso che *entrambe* le
   superfici attraversano sempre. Hanno trovato **tre bug**, nessuno dei quali
   lanciava un errore o falliva un typecheck — vedi sotto. Verificato per
   negativo: 3, 1 e 1 test falliti, esattamente quelli attesi.
5. ~~**`ToolManager`**~~ — **fatto.** [`test/toolManager.test.ts`](proxy/test/toolManager.test.ts):
   23 test su scoring, slot riservato a `UseTool`, raggiungibilità dell'overflow,
   stabilità dei pari merito, promozione e decadimento. Girano sui **pesi di
   default veri** (10 core, 8 promosso, 5 in cronologia, 20 forzato), perché il
   comportamento sta in come si confrontano: un promosso vale 8 contro i 10 di un
   core, quindi da solo non scalza nessuno; promosso *e* visto in cronologia vale
   13, e ce la fa. L'auto-promozione documentata funziona perché i bonus si
   sommano, non perché la promozione basti da sola.

   **Nessun bug nel codice.** Ne ha trovati quattro nei test stessi — vedi sotto.
6. ~~**`checkAutoApprove()`**~~ — **fatto.** [`test/autoApproveConfig.test.ts`](proxy/test/autoApproveConfig.test.ts):
   22 test sul matching delle regole, sui vincoli che devono fallire *chiusi*,
   sui pattern non compilabili e sul contenimento della lettura per il diff.
   **Tre bug** — vedi sotto.

> **I tre bug dell'allowlist.** Due guardie di `checkAutoApprove()` erano scritte
> come `pattern && value && !test(value)`: si legge "controlla il vincolo se c'è",
> significa "tratta come soddisfatto un vincolo che non puoi controllare".
>
> 1. **Un vincolo che non si applica all'azione.** Un `pathPattern` scritto per
>    `bash` — che porta un comando e mai un path — cortocircuitava a *match*.
>    Quindi `{"action":"bash","pathPattern":"^scripts/"}` approvava **ogni**
>    comando di shell senza chiedere: l'esatto contrario di quello che dice, nel
>    file il cui unico mestiere è restringere. È una regola facile da scrivere e
>    non produce nessun errore, nessun log, nessuna differenza visibile finché
>    qualcosa di distruttivo non parte da solo.
> 2. **Un pattern che non compila.** `new RegExp()` stava fuori dal `try` che
>    copre lettura e parsing, quindi un refuso nel pattern attraversava il gate e
>    faceva cadere il turno — mentre la funzione documenta di fallire in silenzio.
> 3. **`loadOldContent()` aveva lo stesso `startsWith` del gate**, e lì decide se
>    un file può essere letto dentro la modale di approvazione.
>
> La correzione dei primi due si muove solo nella direzione di chiedere *di più*,
> che è quella sicura per questo file — ma è un cambio di comportamento: una
> config che era silenziosamente più larga di com'era scritta ora inizierà a
> chiedere.

> **Quattro test che non verificavano niente.** `toolManager.test.ts` era scritto
> con limite 7 su un insieme di esattamente 7 tool. `selectTools` esce subito
> quando `allTools.length <= maxTools`, quindi non filtrava affatto: il tool sotto
> esame era banalmente presente, l'asserzione passava, e quattro test non
> verificavano nulla. Altri due asserivano sulla descrizione di `UseTool` che,
> senza locale caricato, è la stringa `useTool.description` — `t()` restituisce
> la chiave quando manca.
>
> Nessuna delle due cose si vede in una run verde. Un test che non può fallire è
> peggio di un test mancante, perché occupa il posto in cui quello mancante
> sarebbe andato. Ora il limite è una costante con la ragione scritta accanto, il
> locale vero viene caricato in un hook, e i test che dipendono dal filtro
> asseriscono `useToolDef !== null` come guardia.
>
> Vale anche il caso opposto, capitato due volte: **un controllo negativo che
> resta verde** può voler dire che il test è debole *oppure* che il controllo non
> ha introdotto davvero il bug. Rompere l'ordinamento con
> `(b.score - a.score) || 1` non riordina niente — l'insertion sort di V8 sposta
> solo su comparatore negativo — mentre `|| -1` sì, e allora falliscono 5 test.
> Quando un controllo torna verde, la prima cosa da verificare è il controllo.

> **I tre bug dei traduttori.** Nessuno alzava un errore, e per questo erano
> ancora lì.
>
> 1. **Gli argomenti di `UseTool` venivano accumulati due volte.** Alla
>    registrazione della tool call il campo `arguments` veniva inizializzato col
>    primo frammento, che l'accumulatore subito sotto ri-appendeva. I tool
>    normali non leggono quel campo — inoltrano `tc.function.arguments` così
>    com'è — quindi il danno era tutto su `UseTool`, dove quella stringa è ciò
>    che `rewriteUseToolCall()` deve parsare. Una chiamata che arriva intera in
>    un solo delta, cioè il caso comune, produceva
>    `{"tool":"Grep"}{"tool":"Grep"}`: parse fallito, rewrite null, e al client
>    arrivava un blocco `UseTool` ineseguibile. **Il percorso di overflow era
>    rotto**, in silenzio, e solo sui modelli con pochi tool — gli unici che ne
>    hanno bisogno.
> 2. **Il blocco thinking era inchiodato all'indice 0.** Il reasoning arriva
>    quasi sempre per primo, quindi quasi sempre andava bene; un backend che
>    emette una riga di testo *prima* del reasoning si ritrovava un blocco
>    thinking aperto sopra il blocco testo vivo, e i delta successivi finivano su
>    un indice mai aperto.
> 3. **Gli spazi di padding aprivano comunque un blocco di testo.** La guardia
>    esistente scarta il contenuto whitespace-only quando una tool call è già
>    nota, ma l'ordine tipico è l'opposto: il modello emette `"\n\n"` e *poi*
>    chiama il tool. Il README dichiarava il caso gestito; in streaming non lo
>    era.
>
> Il primo è quello che i test hanno quasi mancato: il test iniziale su `UseTool`
> asserviva sul *nome riscritto*, che il fake restituisce comunque, e passava
> contro il bug. L'ha preso il test di fallback, dove gli argomenti grezzi
> finiscono sul filo. Ora il fake registra ogni stringa che riceve.

> **Il bug che i test hanno trovato.** Il gate registrava una concessione
> `scope: "file"` con `full.startsWith(workspaceCwd)`. Non è un test di
> contenimento: con workspace `/ws`, il fratello `/ws-evil/secrets.txt` lo
> supera, perché il confronto ignora il confine di directory — quindi un
> permesso su un file *fuori* dal workspace finiva tra i file fidati per tutta
> la sessione. Non era sfruttabile: `safeResolvePath()` in `workspaceActions.ts`
> rifiuta comunque la scrittura, e il controllo lì è fatto bene. Ma i due strati
> non erano d'accordo su cosa significhi "dentro il workspace", e solo quello
> basso aveva ragione. Ora entrambi i punti del gate usano `relative()`.

**Infrastruttura** — in piedi. `node:test` (built-in, zero dipendenze nuove:
`dependencies` resta `{}`), test in `proxy/test/`, inclusi nel typecheck.
`npm test` in 432 test / ~4 s, senza GPU e senza rete.

`LlmClientPort` e `SseWriterPort` sono già porte, quindi fake-abili senza mock
framework — l'architettura esagonale è già pagata, va solo usata. `ToolProbe`
invece usa `fetch` globale, e il test lo stubba: se un domani diventasse una
porta, il test si semplificherebbe da solo.

**CI** — [`.github/workflows/ci.yml`](.github/workflows/ci.yml): typecheck +
test del proxy, typecheck dell'estensione. Nessuna GPU, ed è il motivo per cui
`regression.sh` non copre questa esigenza e non va confuso con essa.

**Dal 2026-08-27 la pipeline parte solo su richiesta**: `gh workflow run ci.yml
--ref <branch>`. Nessun giro automatico per commit. Un marcatore `[ci]` nel
messaggio di commit era il secondo canale previsto ed è durato un'ora: il commit
che lo introduceva lo *descriveva*, quindi lo conteneva, quindi ha lanciato la
run che serviva a trattenere. Un token abbastanza comune da digitare è
abbastanza comune da citare. È una scelta esplicita e ha
un prezzo altrettanto esplicito: **fra un commit rotto e `main` non c'è più
niente di automatico**. Il cancello sono `npm test` e `npm run typecheck` da
lanciare in locale prima di committare — cioè esattamente ciò che la CI era
stata introdotta per non dover ricordare.

> Uno script `pretest` fallisce se il glob non matcha nulla. Serve: `node --test`
> **esce 0 quando non trova test**, quindi un glob rotto o un Node senza il
> supporto avrebbero prodotto una build verde che non ha verificato niente — lo
> stesso schema di fallimento silenzioso che il progetto ha già mostrato tre volte.

---

## 5. Fase 2 — correttezza nota

Tre problemi già identificati e circoscritti, da affrontare *dopo* i test.

- ~~**Compaction assente dentro il loop.**~~ — **fatta.** Estratta in
  [`services/contextCompactor.ts`](proxy/src/application/services/contextCompactor.ts)
  e chiamata fra un'iterazione e l'altra in *entrambi* i loop: la richiesta in
  ingresso poteva essere piccola ed era il *turno* a crescere, con `read` che
  tronca a 50 KB e fino a 40 iterazioni.

  Estrarla ha fatto emergere un secondo problema, più serio del primo:
  **tagliare per posizione spezza le coppie `tool_use` / `tool_result`**. Dopo la
  traduzione diventano un turno assistant con `tool_calls` e i messaggi `tool`
  che gli rispondono, e al backend basta che manchi una delle due metà per
  rifiutare la richiesta. Succede solo nelle conversazioni lunghe — cioè
  esattamente quelle in cui la compaction gira. `repairToolPairing()` ripara
  entrambe le forme di messaggio, perché la compaction ora gira su entrambi i
  lati della traduzione.
- ~~**Path B è di serie B.**~~ — **sistemato ciò che era una bugia.**
  `MAX_ITERATIONS = 10` era hardcoded mentre il CHANGELOG 1.3.0 dichiarava che il
  limite configurabile "replaces the hardcoded limit of 10": era arrivato solo in
  Path A. Ora Path B riceve lo stesso limite risolto di Path A. Non è un
  dettaglio cosmetico: su un contesto piccolo il tier adattivo scende *sotto*
  dieci, quindi il valore hardcoded sbagliava nella direzione che fa male — dieci
  giri di osservazioni dentro una finestra dimensionata per meno.

  La coda di parametri opzionali è diventata un oggetto `TextualLoopOptions`:
  erano già undici posizionali, e stavo per aggiungere il dodicesimo.

  **Il resto di quella voce era sbagliato.** Diceva che a Path B "manca il
  dispatch parallelo delle azioni read-only": non manca, *non si applica*. Il
  parser si ferma al primo tag completo e scarta il resto del turno, e il manuale
  dice al modello la stessa cosa ("Emit exactly one action at a time"). Non c'è
  mai una seconda azione da dispacciare. Un test lo fissa.

- **Path B non sa esprimere una virgoletta dentro `old_string`** — decisione
  confermata, ma la *conseguenza* era un bug, trovato provando Path B dal vivo il
  2026-08-27. Gli attributi sono parsati con `[^"]*`, quindi `old_string` e
  `new_string` si troncavano **allo stesso prefisso**: `edit` sostituiva una
  stringa con sé stessa, riscriveva il file identico e rispondeva «Replaced 1
  occurrence». Il modello riferiva all'utente una modifica mai avvenuta, citando
  un contenuto mai scritto. Nessun unit test poteva vederlo: li scrivi tutti con
  `old_string` e `new_string` diversi.

  Ora `edit` rifiuta una sostituzione che non può cambiare niente e dice perché,
  e il `TEXTUAL_TOOL_MANUAL` insegna il limite invece di lasciarlo scoprire —
  rifatta la stessa richiesta, il modello ha risposto «since the file contains
  double quotes, I'll rewrite it entirely using `write`» e il file era giusto.
  La grammatica resta quella: Path B è un fallback dichiarato.
- **Un tag `<action>` che il modello non chiude finisce all'utente come testo.**
  È una scelta, non una svista: l'alternativa è perdere in silenzio ciò che il
  modello stava dicendo, che è il modo di rompersi tipico di qui. Un test la
  fissa, così se un giorno diventa "spiegalo a parole" cambia di proposito.
- ~~**`bash` blocca l'event loop**~~ — **fatto.** `bash` e `grep` ora girano
  asincroni, attraverso un solo `runProcess()` in
  [`workspaceActions.ts`](proxy/src/infrastructure/workspaceActions.ts).
  `spawnSync` fermava tutto il processo fino a 30s — le scritture SSE al client,
  il gate di approvazione, la sonda di salute — e trasformava silenziosamente in
  una coda il dispatch parallelo delle azioni read-only, che `grep` è. La
  proprietà è asserita direttamente: un test lancia `sleep 0.4` e conta i tick di
  un timer, che sotto `spawnSync` sono zero.

  Tre cose che `spawnSync` regalava vanno ora fatte a mano, e ognuna ha un test
  perché perderle è silenzioso: il **timeout**, che deve anche *uccidere* il
  processo — il `timeout` di `spawn` manda il segnale ma lascia la promise
  pendente, e una promise che non si risolve appende il turno; il **tetto
  all'output**, perché `spawn` non ha `maxBuffer`; e il **codice di uscita**, che
  arriva su `close` ed è `null` quando a chiudere è stato un segnale.

---

## 6. Fase 3 — feature

In ordine di valore su un modello locale, non di parità con Claude Code.

1. ~~**Memoria cross-sessione.**~~ — **fatta.** `.claudio/MEMORY.md`
   (configurabile con `MEMORY_FILE`, stringa vuota per disattivarla) viene
   anteposto al system prompt quando esiste, tramite un `MemoryRepositoryPort`
   e il `SystemPromptBuilder` — che era già l'unico punto di iniezione.

   **Nessuna azione nuova per scriverlo**, ed è la decisione di progetto che
   conta: il modello aggiorna il file con il `write` ordinario, quindi ogni
   aggiornamento passa dal gate di approvazione come qualunque altra scrittura.
   Una via di scrittura dedicata sarebbe stata una seconda via, non sorvegliata.

   Il prompt riceve la sezione *solo* se c'è del contenuto: niente intestazione
   vuota, niente "(nessuna memoria)". Ogni token speso su una sezione vuota è
   tolto alla conversazione, e su questi modelli la finestra è la risorsa scarsa
   dell'intero progetto.
2. ~~**Verificare il percorso immagini.**~~ — **fatta e provata dal vivo.** La
   traduzione dei blocchi immagine → `image_url` esiste già a
   [`requestTranslator.ts:204`](proxy/src/application/requestTranslator.ts#L204)
   e Claudio permette già di allegare immagini, quindi l'ipotesi era che
   funzionasse senza scrivere niente. Controllando i due punti in cui
   un'immagine attraversa codice *non* coperto dai test ne sono usciti due
   problemi, entrambi silenziosi.

   **Fatto — l'immagine faceva buttare via la conversazione.**
   `estimateTokens()` conta 4 caratteri per token: giusto per la prosa, sbagliato
   di due ordini di grandezza per il base64. Uno screenshot da 500 KB vale
   ~683.000 caratteri, cioè ~171.000 token stimati — più dell'intera finestra
   caricata, per un allegato che il modello paga qualche centinaio di token.
   Nessun errore, nessun rifiuto: semplicemente la compaction scattava su una
   conversazione che ci stava, e `naive` tiene il primo messaggio e gli ultimi
   due — quindi **sopravviveva l'immagine e spariva la storia intorno**. Con la
   compaction semantica attiva il payload finiva anche dentro il prompt di
   riassunto, spedito a un modello di testo. Ora le immagini costano un valore
   nominale fisso al posto del payload, in *entrambe* le forme di messaggio
   (`source.data` lato Anthropic, la data URI in `image_url.url` dopo la
   traduzione), perché la compaction gira su entrambi i lati. Quattro test, con
   controllo negativo.

   **Fatto — il grafico di `python` arriva al modello come immagine.**
   `executeAction` restituiva `result.data` così com'era, e per un plot
   matplotlib quel campo è un PNG in base64: decine di migliaia di token di
   stringa illeggibile come *tool result*, contati per intero perché testo e non
   immagine. Delle tre opzioni (marcatore corto / salvare su disco / blocco
   immagine vero) è stata scelta la terza. `executeAction` ora restituisce un
   `ActionOutcome` — `text` più un `image` opzionale — e la forma del messaggio
   non è una preferenza ma un vincolo del formato: `role: "tool"` accetta una
   stringa, e ogni tool result deve seguire il proprio turno assistant senza
   niente in mezzo. Quindi Path A accoda **prima** tutti i tool result e **poi**
   un solo messaggio user con le immagini del batch; Path B, che di messaggi
   `tool` non ne ha, se la porta dentro l'`<observation>`, che è già un turno
   user. Tutto passa da
   [`services/actionOutcome.ts`](proxy/src/application/services/actionOutcome.ts).

   L'immagine si allega solo se il modello dichiara `type: "vlm"`. È l'unico
   punto del progetto in cui ci si fida dei metadata del backend, e la ragione è
   il modo in cui sbaglia: un modello dichiarato `vlm` per errore fa rifiutare la
   richiesta — rumoroso — mentre non allegare mai è il fallimento silenzioso che
   la modifica serviva a togliere. Su un modello di solo testo il risultato dice
   che un'immagine c'è stata e non è allegata, e suggerisce di salvarla su file:
   tacere lascerebbe il modello a descrivere una figura che non ha mai ricevuto.

   Tredici test, due dei quali leggono il **sorgente spedito** invece di un
   fake — un helper che nessuno chiama supera il typecheck — e controllo negativo
   su sei fronti. Il percorso SSE `/python` verso Claudio era ed è corretto:
   `server.ts` inoltra l'oggetto `{type:"image"}` intero.

   **Fatto anche — la figura finisce su disco** (`PYTHON_PLOT_DIR`, default
   `.claudio/plots`, vuoto per disattivare), come `plot-YYYYMMDD-HHMMSS.png`, e
   il risultato ne dice il path sia al modello che vede sia a quello che non
   vede. Era l'opzione (b), e non è alternativa alla (c): l'immagine allegata è
   ciò che vede il *modello*, il file è l'unico appiglio che ha una *persona* su
   una figura che altrimenti esiste solo dentro la conversazione. Il nome porta
   un contatore oltre all'orologio, perché due plot nello stesso secondo sono il
   caso normale (il modello disegna, guarda, ridisegna) e la scrittura usa `wx`,
   quindi non sovrascrive mai. Il path passa dallo stesso `safeResolvePath()` di
   ogni altra scrittura: una `PYTHON_PLOT_DIR` sbagliata non è una via d'uscita
   dal workspace. Un salvataggio fallito lo dice nel testo e l'immagine arriva
   lo stesso: si perde la figura, non il turno. Otto test, quattro controlli
   negativi. Niente fa pulizia della directory: merita una riga di `.gitignore`,
   non del codice che cancella file dell'utente.

   **Prova end-to-end — fatta il 2026-08-27**, con `qwen/qwen3.8-27b` (vlm,
   119.552 token) caricato in LM Studio e il proxy in ascolto su 5678.

   | Prova | Esito |
   |---|---|
   | Immagine in ingresso, percorso traduzione (nessun header) | tre bande colorate → «Red, green, blue» |
   | Immagine in ingresso, agent loop (`x-workspace-root`) | «qual è la banda centrale?» → «Green» |
   | `python` che disegna, loop in modalità auto | figura salvata in `.claudio/plots/`, descritta dal modello |
   | **Discriminante** | codice con `n = random.randint(3,9)` mai stampato, dot rossi disegnati e basta → il modello risponde **7**; il PNG salvato ne contiene **7** |

   Le prime tre non provano niente da sole: la descrizione del grafico era
   deducibile dal codice che il modello aveva appena scritto. La quarta sì —
   quel numero esiste solo dentro l'immagine, e la verifica è stata fatta
   guardando il file. **Il percorso immagini funziona davvero, in entrambe le
   direzioni.**

   **La prova ha trovato un bug che nessuna suite avrebbe trovato.** Al primo
   tentativo il turno è morto un'iterazione dopo, con una pagina HTML di errore
   dentro la risposta: il modello aveva emesso una tool call con **argomenti
   vuoti**, e il loop rigioca la propria storia così com'è. Misurato contro LM
   Studio, un `tool_calls` il cui `arguments` non è la stringa di un *oggetto*
   JSON viene rifiutato: `""` → 500, `"   "` → 500, `{"action":` troncato → 500,
   `"null"` → 400, `"{}"` → 200. Ora gli argomenti vengono normalizzati dove si
   costruisce il turno assistant, con lo stesso fallback che usa l'esecutore —
   così la storia concorda con il tool result che le sta accanto — e la
   sostituzione viene loggata. Quattro test, due controlli negativi.
3. **Misurato il 2026-08-27 — le tool call testuali sono un fantasma.** Durante
   le prove end-to-end il modello aveva risposto una volta con una tool call
   scritta *come testo* (`<tool_call><function=workspace>…`), che Path A non
   parsa: turno perso. La domanda era quanto spesso capita. Risposta: **mai
   più, in 39 chiamate live** — 15 con un system prompt minimo, 12 con quello
   spedito, 12 in streaming, su forme di prompt scelte per somigliare a quella
   che aveva fallito. Nessun parser scritto: costruire per quel caso sarebbe
   costruire per un fantasma. La misura *è* il risultato.

   Ha però trovato due cose che valgono più di quella cercata, entrambe
   sistemate: il prompt non nominava `python` (implementato, esposto nello
   schema, e assente da ogni prompt — il modello che legge le istruzioni conclude
   che l'azione non esista, ed è letteralmente ciò che aveva detto), e la tool
   call vuota ha una causa misurabile — `max_tokens` che tronca la generazione:
   `finish_reason: "length"` e zero argomenti accumulati, riproducibile a
   comando. Il loop ora lo dice al modello e chiede di rimandare la chiamata,
   invece di eseguire `list .` al posto suo.

4. **Parità con Claude Code — decisa, vedi §7.** Si fanno TodoWrite + Skills,
   poi Hooks, poi MCP, in quest'ordine e tutte dentro il loop del proxy (cioè
   per Claudio: sulla CLI ci pensa già Claude Code). Restano fuori sub-agent,
   web tools e worktree: costano quanto le altre e rendono meno su un 27B.

---

## 7. Decisioni aperte

> **Principio, fissato il 2026-08-27.** La parte *intelligente* del progetto è il
> proxy. Claudio e la CLI sono superfici: disegnano, raccolgono click, possiedono
> un editor. Ogni regola — cosa si può fare a un workspace, quando si chiede a un
> umano, cosa viene detto al modello, quando si taglia il contesto, come si
> gestisce il ciclo di vita del proxy — sta nel proxy, **una volta sola**. Dove una
> regola è scritta due volte, la seconda copia è un bug che verrà trovato a parte:
> `ProxyManager` e `start_agent_cli.sh` uccidevano entrambi il proxy per il pid del
> wrapper, e lo stesso processo orfano è stato corretto in uno e non nell'altro
> finché sono rimasti due.

- **`claude_code/` è zavorra o archivio?** 1.902 file e 33 MB tracciati in git,
  mai toccati, mai importati. Se il progetto da far vivere è il proxy, pesa su
  ogni clone e ogni ricerca. Dipende se il repo è "l'archivio del leak, con in
  più un proxy" o "il mio proxy, con in più un archivio".
- **Fino a dove seguire la CLI?** Claudio è la superficie primaria, ma la CLI
  funziona e ora ha i tool nativi interi. Ogni feature va decisa sapendo quale
  delle due serve.
- ~~**Quale parità serve davvero?**~~ — **decisa il 2026-08-27.** Entrambe le
  superfici servono, a seconda del compito: Claudio per l'iterazione
  nell'editor, la CLI per i lavori lunghi. E si costruiscono **TodoWrite +
  Skills, Hooks e MCP**, in quest'ordine.

  La conseguenza va detta perché non è ovvia: **tutte e tre vivono nel loop del
  proxy, quindi servono solo Claudio.** Claude Code le implementa già di suo, e
  sulla CLI il proxy resta un traduttore che non deve fare niente di nuovo.
  Costruirle significa far raggiungere a Claudio quello che la CLI ha già — che
  è una scelta legittima, dato che metà del lavoro si fa lì dentro, ma non è
  "aggiungere capacità al progetto": è aggiungerle a *una* delle due superfici.

  L'ordine è per costo crescente e per quanto aiutano un modello piccolo:

  1. ~~**TodoWrite**~~ — **fatta il 2026-08-27.** `action="todo"` scrive
     `.claudio/TODO.md` (configurabile con `TODO_FILE`, vuoto per disattivare) e
     il prompt la rilegge all'inizio di ogni turno. L'azione **non porta un
     path**: scrive quell'unico file e non può essere puntata altrove, ed è per
     questo che è auto-approvata invece di alzare una modale per ogni casella.
     Misurata dal vivo: su un compito da tre passi il modello non tiene lista, e
     fa bene; su uno da sei la scrive come terza azione, senza che il prompt
     glielo chieda, e alla fine la riscrive con tutte le caselle spuntate.
  2. ~~**Skills**~~ — **fatta il 2026-08-27.** Una skill è una directory con un
     `SKILL.md`, in `.claudio/skills/` o in una `GLOBAL_SKILLS_DIR` condivisa;
     quella del progetto vince sul nome. Nel prompt sta **solo l'indice** — un
     nome e una riga ciascuna — e il corpo arriva quando il modello chiama
     `action="skill"`. Gli script che una skill porta si eseguono con le azioni
     ordinarie, quindi passano dal gate: nessun canale di esecuzione privato.
     Misurata dal vivo: data una skill con tre regole volutamente indovinabili
     da nessuno, il modello l'ha caricata come **prima azione** e le ha seguite
     tutte e tre.
  3. **Hooks** — comandi dell'utente su evento (lint dopo `write`, test dopo
     `edit`). Sposta lavoro dal modello a comandi deterministici, che su un 27B
     è spesso la mossa giusta. Va progettato *con* il gate di approvazione: senza,
     è una via per eseguire comandi senza chiedere.
  4. **MCP** — il modello che usa server esterni. Massimo valore potenziale e di
     gran lunga il costo maggiore: il proxy diventa un client MCP, con handshake,
     scoperta dei tool e ciclo di vita — e ogni tool scoperto compete per i pochi
     slot che il modello regge. Ultima proprio per questo.
- **La pipeline non è più una barriera.** Dal 2026-08-27 la CI parte solo su
  richiesta, quindi fra un commit rotto e `main` non c'è più niente di
  automatico. Chi riprende deve saperlo prima di committare, non dopo.

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
- **I fake possono essere più indulgenti della realtà.** I test del prompt
  builder usano un repository che fa da eco ai parametri, quindi passavano
  mentre l'`agent-base.md` spedito non aveva `{{memorySection}}` e la memoria
  non arrivava da nessuna parte. Dove un fake sostituisce un *file su disco*,
  almeno un test deve leggere il file vero. Stessa forma dei bug di Path B: un
  test che confronta con una lista scritta nel test dimostra solo che la lista
  coincide con sé stessa.
- **Misurare, non dedurre.** Le capacità dei modelli non si trasferiscono tra
  modelli, e i metadata dichiarati dal backend non sono affidabili. Il codice lo
  sapeva già; il modo di lavorare deve saperlo altrettanto.

---

## 9. Da dove ripartire

Scritta il 2026-08-27, alla fine di una sessione lunga. Se stai riprendendo in
mano il progetto dopo settimane, questa sezione è il punto di ingresso: dice
cos'è vero oggi, cosa si può fare senza decidere niente, e cosa invece richiede
prima una tua decisione.

### Verificare in trenta secondi

```bash
cd proxy && npm test && npm run typecheck     # 432 test, ~4 s
cd chat-extension && npm run typecheck
```

Niente GPU, niente LM Studio, niente rete. Se sono verdi, il codice è nello
stato descritto qui. **La CI non parte più da sola**: `gh workflow run ci.yml
--ref main`. Fra un commit rotto e `main` non c'è più niente di automatico, e
questi due comandi sono il cancello.

### Cos'è vero oggi

| | Stato |
|---|---|
| Fase 0 (pulizia, probe, guard) | chiusa |
| Fase 1 (rete di sicurezza) | chiusa — da 0 a 432 test |
| Fase 2 (correttezza nota) | **chiusa**: compaction nei loop, limite iterazioni in Path B, `bash`/`grep` non bloccanti |
| Fase 3.1 memoria cross-sessione | fatta |
| Fase 3.2 percorso immagini | fatto e **provato dal vivo** su `qwen/qwen3.8-27b` |
| Fase 3.3 tool call testuali | misurato: fantasma, nessun parser scritto |
| Fase 3.4 parità con Claude Code | **ferma su una decisione tua**, vedi §7 |

Restano tre *decisioni* registrate in §5 (il mapping di `tool_choice: "any"`, lo
stream troncato senza `[DONE]`, le virgolette dentro `old_string` in Path B) e
quelle di §7. Ognuna ha un test che fissa il comportamento di oggi: non sono
buchi, sono scelte.

### Lavoro utile che non richiede decisioni

In ordine di resa, e nessuno dei tre è grande:

1. ~~Coprire lo `slashCommandInterceptor`~~ e ~~`buildWorkspaceContextSummary`~~
   — **fatti il 2026-08-27**, ed erano gli ultimi due componenti nella lista di
   [testing.md](proxy/docs/testing.md#not-covered-yet). Hanno trovato quattro
   guasti silenziosi: `/brief` senza traduzione in nessuna delle due lingue (la
   palette di Claudio mostrava la chiave grezza), un comando digitato insieme a
   un allegato che non veniva intercettato (si leggeva `content[0]`), un
   workspace illeggibile che produceva un riassunto **vuoto** iniettato nel
   prompt, e un elenco di primo livello senza tetto che su una directory grande
   si mangiava la finestra di contesto.
2. ~~Claudio senza un solo test~~ — **fatto il 2026-08-27: 63 test** (52 host,
   11 webview) con lo stesso runner del proxy, più
   `chat-extension/scripts/approval-e2e.ts` che prova il handshake vero contro
   un proxy acceso, come fa `regression.sh` per il proxy. Coprono il parser SSE,
   il client, il bridge di approvazione e l'assemblaggio dei messaggi in
   streaming. **Nessun template Angular viene renderizzato**: servirebbe un
   secondo runner, e la scelta è stata di non averlo — scritto qui perché sia
   dichiarato, non scoperto.
3. **Quel che resta senza suite** è probing di avvio, adapter sottili e il
   wiring: vale meno, perché o è composizione o è I/O che un test finirebbe per
   simulare. Il candidato meno inutile è l'orchestrazione del probe
   (`toolLimitDetector`), dove una cache letta male vale un modello mutilato.
4. **La CLI è stata provata il 2026-08-27**, per la prima volta:
   `proxy/scripts/cli-e2e.sh` lancia Claude Code attraverso il proxy e verifica
   due turni — una risposta semplice e uno che usa il tool `Read` della CLI,
   cioè il giro `tool_use`/`tool_result` che è la parte che si rompe in
   silenzio. Entrambi come atteso. Una cosa da correggere nei documenti: Claude
   Code in `--print` manda **3 tool**, non i ~40 che questo repo ha sempre
   assunto — quel numero è di una sessione interattiva.
5. **Rimisurare il modello quando lo cambi.** Il probe è l'autorità e i numeri
   di §2 valgono per *quel* modello: tetto dei tool, thinking, finestra. Non
   trasferirli.

Path B non è più fra questi: **provato dal vivo il 2026-08-27** forzando
`MAX_TOOLS=0`. `read`, `write`, `bash`, `edit`, `python` e la scrittura
multi-riga funzionano davvero, i file finiscono sul disco — e la prova ha trovato
l'`edit` che diceva di aver funzionato senza farlo (§5).

### Trappole che questo repo ha già pagato

- **Un test che non può fallire** occupa il posto di quello mancante. Ogni test
  nuovo va visto fallire.
- **Un controllo negativo che torna verde** può voler dire che il test è debole
  *oppure* che il controllo non ha introdotto il bug. È capitato due volte, la
  seconda per un'indentazione sbagliata in un `perl -0pi`. Verifica il controllo
  prima del test.
- **Un fake più indulgente della realtà.** Dove un fake sostituisce un file su
  disco o una risposta del backend, almeno un test deve leggere l'artefatto
  vero. Tre bug trovati così, l'ultimo il 2026-08-27: il prompt spedito non
  nominava l'azione `python`.
- **Il backend rifiuta più di quanto sembri.** Un `tool_calls` con `arguments`
  che non è la stringa di un oggetto JSON dà 500. Misurato, non dedotto.
