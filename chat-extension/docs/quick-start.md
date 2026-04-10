# Claudio — Quick Start

> Step-by-step guide to install Claudio and get it running in under 15 minutes.

---

## Prerequisites checklist

Verify each item before proceeding:

### Node.js 18+

```bash
node --version
```

Must show `v18.x.x` or higher. If the command is missing or the version is lower:

1. Go to **https://nodejs.org**
2. Download the **LTS** (Long Term Support) version
3. Run the installer and follow the prompts
4. Reopen the terminal and verify: `node --version`

### npm 9+

```bash
npm --version
```

npm is included with Node.js. If the version is below 9, update Node.js.

### VS Code 1.85+

```bash
code --version
```

If the command is missing: download VS Code from **https://code.visualstudio.com** and install it.

### Python 3.8+ (optional — required only for code execution)

```bash
python3 --version
```

If you want the code execution feature and don't have Python:
- **macOS:** `brew install python3` or https://python.org
- **Linux:** `sudo apt install python3`
- **Windows (WSL2):** `sudo apt install python3`

Without Python, everything else in Claudio works normally.

### proxy/ dependencies installed

```bash
cd proxy && npm install && cd ..
```

One-time step. The proxy dependencies must be installed before Claudio can start the proxy automatically.

---

## Proxy Auto-Start

Starting from v1.1.0, Claudio starts and stops the proxy automatically.
The repo includes a `.vscode/settings.json` that enables this:

```json
{
  "claudio.proxyDir": "${workspaceFolder}/proxy",
  "claudio.autoStartProxy": true
}
```

When this setting is in place:
- The proxy starts when VS Code opens the project folder
- The proxy stops when the VS Code window closes
- A free port is discovered automatically — no port conflicts with other agents

**Requirements for auto-start:**
- Node.js 18+ must be in PATH (verify: `node --version`)
- `cd proxy && npm install` must have been run at least once
- LM Studio (or your LLM backend) should be running

If `claudio.proxyDir` is empty (or auto-start is disabled), start the proxy manually:

```bash
cd proxy && npm start
```

---

## Step-by-step installation

### Step 1 — Go to the extension directory

```bash
cd /path/to/repo/chat-extension
```

Replace `/path/to/repo` with the actual path where you cloned the repository.

### Step 2 — Install extension host dependencies

```bash
npm install
```

Installs esbuild (bundler), TypeScript, and `@vscode/vsce` (tool for creating .vsix packages).

Expected output:
```
added 42 packages in 3s
```

### Step 3 — Install webview UI dependencies

The webview is a separate Angular application with its own dependencies:

```bash
cd src/webview-ui
npm install
cd ../..
```

Installs Angular 19, Bootstrap, KaTeX (math formulas), marked (Markdown), @ngx-translate (i18n).

Expected output:
```
added 1247 packages in 45s
```

> This step takes longer because Angular has many dependencies. Waiting 30–60 seconds is normal.

### Step 4 — Build the extension

```bash
npm run build
```

This:
1. Compiles the Angular webview → `dist/webview-ui/`
2. Compiles the extension host TypeScript → `dist/extension.js`

Expected output:
```
> npm run build:webview
...
✔ Browser application bundle generation complete.

> npm run build:extension
...
dist/extension.js  [bundled]
```

If the build fails: see [Troubleshooting](troubleshooting.md).

### Step 5 — Create the .vsix package

```bash
npm run package
```

Expected output:
```
DONE  Packaged: claudio-0.1.0.vsix (X files, Y MB)
```

The file `claudio-0.1.0.vsix` is created in the `chat-extension/` directory.

### Step 6 — Install in VS Code

```bash
code --install-extension claudio-0.1.0.vsix
```

Expected output:
```
Extension 'claudio-0.1.0.vsix' was successfully installed.
```

### Step 7 — Reload VS Code

After installation, **reload VS Code**:

- Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
- Type: `Reload Window`
- Press Enter

---

## First use

After reloading:

1. **Find the Claudio icon** in the Activity Bar (the vertical bar on the left with icons). Look for a chat/speech-bubble icon.

2. **Click the icon** → the Claudio panel opens in the sidebar

3. **Check the connection indicator** at the top of the panel:
   - `● Connected` (green) → everything is working
   - `○ Disconnected` (red) → the proxy is not running

4. **Type your first message**: write `Hello!` in the text box at the bottom and press Enter or click ▶

5. The response appears in streaming (text grows in real time)

---

## Configuration (optional)

To change the proxy host/port (non-standard setups):

1. Open VS Code settings: `Ctrl+,` (or `Cmd+,` on Mac)
2. Search for `claudio`
3. Edit:
   - **Proxy Host**: `http://127.0.0.1` (default)
   - **Proxy Port**: `5678` (default)

Or edit `settings.json` directly:

```json
{
  "claudio.proxyHost": "http://127.0.0.1",
  "claudio.proxyPort": 5678
}
```

---

## Verification checklist

Check each item to confirm everything is working:

- [ ] `node --version` shows v18+
- [ ] `npm --version` shows 9+
- [ ] `code --version` shows 1.85+
- [ ] `cd proxy && npm install` completed without errors
- [ ] `npm install` completed without errors (in `chat-extension/`)
- [ ] `cd src/webview-ui && npm install` completed without errors
- [ ] `npm run build` completed without errors (creates `dist/extension.js`)
- [ ] `npm run package` creates `claudio-0.1.0.vsix`
- [ ] `code --install-extension claudio-0.1.0.vsix` shows "successfully installed"
- [ ] After "Reload Window", the Claudio icon appears in the Activity Bar
- [ ] The Claudio panel shows `● Connected` (proxy started automatically)
- [ ] The first message receives a streaming response

---

## If something doesn't work

See the dedicated guide: [Troubleshooting](troubleshooting.md)

Most common causes:
- **Red indicator**: proxy not running → reload VS Code (triggers auto-start), or run `cd proxy && npm start`
- **Build fails**: missing dependencies → repeat Step 2 or 3
- **Icon not visible**: extension not activated → check the Extensions panel in VS Code

---

## Next steps

- [Slash Commands](slash-commands.md) — full reference of available commands
- [Architecture](architecture.md) — internal structure for developers who want to contribute
- [Proxy Quick Setup](../../proxy/docs/quick-setup.md) — proxy configuration (if not done yet)
- [Proxy Lifecycle](../../proxy/docs/lifecycle.md) — multi-instance architecture and port discovery
