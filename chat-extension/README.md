# Claudio — VS Code Chat Extension

**Claudio** è un'estensione VS Code che fornisce un'interfaccia chat per interagire con il proxy Anthropic-to-OpenAI direttamente dall'editor. Supporta streaming in tempo reale, esecuzione codice Python, allegati file e slash command.

> Starting from v1.1.0, Claudio starts and stops the proxy automatically. No separate terminal needed.

---

## Funzionalità

- **Streaming chat** — risposte in tempo reale con Markdown (syntax highlighting) e formule matematiche (KaTeX)
- **Esecuzione codice Python** — esegui snippet Python nella chat; il venv viene creato e gestito automaticamente
- **Allegati file** — allega file di testo e immagini (PNG, JPG, GIF, WebP) alla conversazione
- **Slash command** — comandi rapidi integrati (vedi tabella sotto)
- **Health monitoring** — indicatore di connessione al proxy, riconnessione automatica ogni 10s, pulsante di riconnessione manuale con restart automatico del proxy
- **i18n** — interfaccia in Inglese e Italiano (segue la lingua configurata nel proxy)
- **Thinking blocks** — visualizza i blocchi di ragionamento esteso del modello in un pannello espandibile

---

## Prerequisiti

| Strumento | Versione minima | Installazione | Verifica |
|-----------|----------------|---------------|---------|
| Node.js | 18.x LTS | https://nodejs.org (scegli "LTS") | `node --version` |
| npm | 9.x (incluso) | Incluso con Node.js | `npm --version` |
| VS Code | 1.85.0 | https://code.visualstudio.com | `code --version` |
| Python | 3.8+ (opzionale) | https://python.org | `python3 --version` |
| **proxy/ deps** | — | `cd proxy && npm install` | una sola volta |

> **Python è opzionale.** Senza Python, la funzione di esecuzione codice mostra un errore, ma chat, allegati e slash command funzionano normalmente.

> **Il proxy si avvia automaticamente** quando apri il progetto in VS Code (configurazione inclusa nel `.vscode/settings.json`). Non occorre `sh start.sh` o `npm start` manuale.

---

## Installazione

Esegui questi comandi nella directory `chat-extension/`:

```bash
# 1. Vai nella directory dell'estensione
cd chat-extension

# 2. Installa le dipendenze dell'extension host
#    (esbuild, TypeScript, @vscode/vsce)
npm install

# 3. Installa le dipendenze della webview UI
#    (Angular 19, Bootstrap, KaTeX, marked, @ngx-translate)
cd src/webview-ui && npm install && cd ../..

# 4. Compila tutto (extension host + webview)
npm run build
# Output atteso:
#   ✓ Built dist/extension.js
#   ✓ Built dist/webview-ui/

# 5. Crea il pacchetto .vsix
npm run package
# Output atteso:
#   DONE  Packaged: claudio-0.1.0.vsix

# 6. Installa l'estensione in VS Code
code --install-extension claudio-0.1.0.vsix
# Output atteso:
#   Extension 'claudio-0.1.0.vsix' was successfully installed.
```

Dopo l'installazione, **ricarica VS Code** (Ctrl+Shift+P → digita "Reload Window" → invio).

L'icona di Claudio apparirà nella Activity Bar laterale sinistra di VS Code.

---

## Configurazione

Claudio si configura tramite le impostazioni di VS Code (Ctrl+, → cerca "Claudio"):

```json
{
  "claudio.proxyDir": "${workspaceFolder}/proxy",
  "claudio.proxyHost": "http://127.0.0.1",
  "claudio.proxyPort": 5678,
  "claudio.autoStartProxy": true
}
```

This configuration is already included in the repo's `.vscode/settings.json` — no manual editing required.

| Impostazione | Tipo | Default | Descrizione |
|---|---|---|---|
| `claudio.proxyDir` | stringa | `""` | Percorso assoluto a `proxy/`. Supporta `${workspaceFolder}`. Vuoto = proxy esterno. |
| `claudio.autoStartProxy` | booleano | `true` | Avvia/ferma il proxy automaticamente. Richiede `proxyDir`. |
| `claudio.proxyHost` | stringa | `http://127.0.0.1` | Host del proxy (senza porta) |
| `claudio.proxyPort` | numero | `5678` | Porta base per il port discovery |

> **Tutte le altre impostazioni** (temperatura, system prompt, modello, locale, max_tokens) vengono lette automaticamente dall'endpoint `GET /config` del proxy. Non è necessario duplicarle nell'estensione.

---

## Primo utilizzo

1. Esegui `cd proxy && npm install` (una sola volta)
2. Apri VS Code nella **root del repository**
3. Claudio avvia il proxy automaticamente (grazie a `.vscode/settings.json`)
4. Clicca sull'icona **Claudio** nella Activity Bar (look: icona chat)
5. Il pannello si apre: l'indicatore in alto mostra `● Connected` (verde)
6. Digita un messaggio e premi Invio o clicca il tasto ▶

---

## Slash Command

Digita `/` nella casella di testo per vedere i comandi disponibili.

### Comandi gestiti dal proxy

| Comando | Descrizione | Prerequisiti |
|---------|-------------|-------------|
| `/status` | Mostra versione proxy, porta, Node.js version, working directory | — |
| `/version` | Mostra la versione del pacchetto proxy | — |
| `/commit` | Legge il diff staged + ultimi commit → LLM scrive il commit message | File in staging (`git add`) |
| `/diff` | Legge `git diff HEAD` → LLM spiega le modifiche | Repository git |
| `/review` | Legge il diff rispetto a main/master → LLM fa code review | Repository git con branch main/master |
| `/compact` | Chiede all'LLM di riassumere la conversazione corrente | — |
| `/brief` | Chiede all'LLM di rispondere brevemente (max 3 frasi) | — |
| `/plan` | Chiede all'LLM di ragionare step-by-step prima di rispondere | — |

### Comandi gestiti dall'estensione (client-side)

| Comando | Descrizione | Prerequisiti |
|---------|-------------|-------------|
| `/files` | Lista i file aperti nel workspace → chiede all'LLM cosa vuoi sapere | Workspace aperto in VS Code |
| `/simplify` | Invia il file aperto nell'editor attivo → LLM suggerisce semplificazioni | File aperto nell'editor |
| `/copy` | Copia l'ultima risposta negli appunti | — |
| `/branch` | Apre il terminale con `git checkout -b ` pronto | Terminale VS Code |
| `/commit-push-pr` | Apre il terminale con il flusso commit → push → PR | `gh` CLI installato |
| `/pr-comments` | Apre il terminale con `gh pr view --comments` | `gh` CLI installato |
| `/clear` | Cancella la cronologia della conversazione | — |

---

## Esecuzione codice Python

Claudio può eseguire snippet Python direttamente nella chat:

1. Scrivi un messaggio con un blocco di codice Python, o chiedi all'LLM di generarne uno
2. Clicca il pulsante ▶ che appare sopra il blocco di codice
3. L'output viene mostrato sotto il blocco

**Gestione automatica dell'ambiente** (gestita dal proxy, non dall'estensione):
- Al primo utilizzo, il proxy crea un venv in `.claudio/python-venv` nella root del workspace
- I pacchetti mancanti vengono rilevati e installati automaticamente prima di ogni esecuzione
- I grafici matplotlib (`plt.show()`) vengono catturati e mostrati come immagine PNG nella chat
- L'LLM può eseguire Python direttamente nel loop agente via `workspace(action="python", ...)`

**Fasi di esecuzione** mostrate nella UI:
- `Creating virtual environment...`
- `Installing missing packages...`
- `Executing code...`

---

## Allegati file

Per allegare file alla conversazione:

1. Clicca l'icona 📎 nella barra degli input
2. Seleziona uno o più file dal filesystem
3. I file vengono aggiunti come allegati al messaggio successivo

**Tipi supportati:**
- **Immagini** (PNG, JPG, GIF, WebP) → inviate come blocchi immagine base64
- **File di testo** (qualsiasi estensione) → inviati come blocchi di testo con fenced code block

---

## Verifica

Dopo l'installazione, verifica che tutto funzioni:

```bash
# 1. Proxy in esecuzione
curl http://127.0.0.1:5678/health
# Atteso: {"status":"ok","target":"..."}

# 2. Estensione installata
code --list-extensions | grep claudio
# Atteso: local.claudio

# 3. Config del proxy disponibile
curl http://127.0.0.1:5678/config
# Atteso: JSON con model, temperature, ecc.
```

In VS Code: apri il pannello Claudio → l'indicatore mostra `● Connected` → digita "Ciao!" → la risposta appare in streaming.

---

## Troubleshooting

| Sintomo | Causa | Soluzione |
|---|---|---|
| Indicatore rosso "Disconnected" | Proxy non in esecuzione | `sh start.sh` o `cd proxy && npm start` |
| Icona Claudio non visibile | Estensione non attivata | Controlla Extensions panel → cerca "Claudio" → assicurati che sia abilitata |
| Indicatore rosso anche col proxy attivo | Host/porta errati nelle impostazioni | Controlla `claudio.proxyHost` e `claudio.proxyPort` in VS Code settings |
| Risposta `503 Proxy is still initializing` | `initializeTools()` ancora in esecuzione | Attendi 5–30s per il probe in background, poi riprova |
| "Python not found" nell'esecuzione codice | Python 3 non in PATH sul server proxy | Installa Python 3.8+ da https://python.org |
| `npm run build` fallisce sulla webview | Dipendenze Angular mancanti | Esegui `cd src/webview-ui && npm install` prima di `npm run build` |
| `npm run package` fallisce | `@vscode/vsce` non trovato | Esegui `npm install` nella root di `chat-extension/` |
| L'estensione si installa ma crasha all'attivazione | `dist/extension.js` mancante | Esegui `npm run build` prima di `npm run package` |

**Per vedere i log dell'estensione:**
- VS Code → Help → Toggle Developer Tools → Console
- Filtra per "Claudio" per trovare i messaggi rilevanti

**Log del proxy:**
- `proxy/proxy.log` (quando avviato con `start.sh`)
- o direttamente nel terminale dove gira il proxy

---

## Documentazione tecnica

- [Quick Start](docs/quick-start.md) — guida passo-passo per principianti
- [Architecture](docs/architecture.md) — struttura interna per sviluppatori
- [Slash Commands](docs/slash-commands.md) — riferimento completo dei comandi
- [Troubleshooting](docs/troubleshooting.md) — risoluzione problemi avanzata
