# Claudio — Troubleshooting

> Guide to diagnosing and resolving the most common problems.

---

## Quick diagnostic checklist

Before searching the table below, run these checks:

```bash
# 1. Is the proxy running? (look for the port Claudio chose)
curl http://127.0.0.1:5678/health
# Expected: {"status":"ok","target":"..."}
# If port 5678 is not right, check the "Claudio Proxy" Output Channel in VS Code
# (View → Output → select "Claudio Proxy") to see the actual port.

# 2. Node.js version?
node --version
# Expected: v18.x.x or higher

# 3. VS Code version?
code --version
# Expected: 1.85.0 or higher

# 4. Extension installed?
code --list-extensions | grep claudio
# Expected: local.claudio

# 5. Build present?
ls chat-extension/dist/extension.js
# Must exist
```

After checking everything: **reload VS Code** (Ctrl+Shift+P → "Reload Window") and try again.

---

## Proxy auto-start issues

### Proxy does not start automatically

**Cause:** `claudio.proxyDir` not configured.

**Solution:** open VS Code settings (Ctrl+,), search for "claudio", and set:
- **Proxy Dir**: `${workspaceFolder}/proxy` (or the absolute path to the `proxy/` folder)
- **Auto Start Proxy**: enabled

Or open `.vscode/settings.json` in the repo root and verify it contains:
```json
{
  "claudio.proxyDir": "${workspaceFolder}/proxy",
  "claudio.autoStartProxy": true
}
```

Then reload VS Code (Ctrl+Shift+P → "Reload Window").

---

### Proxy starts but crashes immediately

**Cause:** `npm install` has not been run in `proxy/`.

**Solution:**
```bash
cd proxy && npm install
```

Reload VS Code after that.

---

### "Node.js not found" error notification

**Cause:** Node.js is not in the PATH that VS Code uses.

**Solution:** reinstall Node.js from https://nodejs.org and restart VS Code.
On macOS, if Node.js is installed via nvm or Homebrew, ensure it's available in the
shell profile that VS Code inherits (`~/.zshrc`, `~/.bash_profile`, etc.).

---

### Proxy starts on an unexpected port

**Behavior:** Claudio performs port discovery starting from `claudio.proxyPort` (default 5678).
If 5678 is occupied (e.g. by another Claudio window or `start_agent_cli.sh`), it picks 5679, 5680, etc.

**To see the actual port:** View → Output → select "Claudio Proxy" in the dropdown.

---

## Connection problems

### Red "Disconnected" indicator in the Claudio panel

**Most common cause:** the proxy is not running.

**Solution:** if `claudio.proxyDir` is configured, reload VS Code to trigger auto-start.
Otherwise start the proxy manually:
```bash
# From repo root
cd proxy && npm start
```

Wait for the panel to show `● Connected` (can take 5–10 seconds on first start).

---

### Red indicator even with the proxy running

**Likely cause:** wrong host or port in VS Code settings.

**Solution:**
1. Open VS Code settings: `Ctrl+,`
2. Search for `claudio`
3. Verify `Proxy Host` is `http://127.0.0.1` and `Proxy Port` is `5678`
4. Reload VS Code

Or verify the settings file directly:
```json
{
  "claudio.proxyHost": "http://127.0.0.1",
  "claudio.proxyPort": 5678
}
```

---

### Proxy responds `503 Proxy is still initializing`

**Cause:** the proxy is started but `initializeTools()` (the tool probe) is still running in background.

**Solution:** wait 5–30 seconds and retry. The binary search probe that detects the model's tool limit can take time if the model is slow to respond.

You can speed up the next start by setting `MAX_TOOLS` to a fixed value in `proxy/.env.proxy`:
```env
MAX_TOOLS=7
```

---

## Extension issues

### Claudio icon missing from the Activity Bar

**Cause 1:** extension not installed or not activated.

**Solution:**
1. Open the Extensions panel (`Ctrl+Shift+X`)
2. Search for "Claudio"
3. If it shows an "Install" button → click Install
4. If it shows "Disable" → click "Enable"
5. Reload VS Code

**Cause 2:** `dist/extension.js` does not exist (build not run).

**Solution:**
```bash
cd chat-extension
npm run build
npm run package
code --install-extension claudio-0.1.0.vsix
```

---

### Extension installs but crashes on activation

**Symptom:** VS Code shows an error like "Extension 'claudio' failed to activate" or the Claudio icon is unresponsive.

**Most likely cause:** `dist/extension.js` is missing or corrupted.

**Solution:**
```bash
cd chat-extension
npm run build   # recompile everything
npm run package
code --install-extension claudio-0.1.0.vsix
# Reload VS Code
```

**How to see the full error:**
- Help → Toggle Developer Tools → Console
- Look for red error messages related to "Claudio" or "activation"

---

### Claudio panel appears blank or doesn't load

**Cause 1:** Angular webview not compiled.

**Solution:**
```bash
cd chat-extension
npm run build   # compiles both webview and extension host
npm run package
code --install-extension claudio-0.1.0.vsix
```

**Cause 2:** Content Security Policy blocking.

**How to diagnose:**
- Help → Toggle Developer Tools → Console
- Look for errors with "Content Security Policy" or "CSP"

Report the issue on GitHub with the full console output.

---

## Build issues

### `npm run build` fails with Angular error

**Symptom:**
```
ERROR in src/webview-ui/...
Cannot find module '@angular/...'
```

**Cause:** webview dependencies not installed.

**Solution:**
```bash
cd chat-extension/src/webview-ui
npm install
cd ../..
npm run build
```

---

### `npm run build` fails with TypeScript error (extension host)

**Symptom:**
```
error TS2307: Cannot find module 'vscode'
```

**Cause:** extension host dependencies not installed.

**Solution:**
```bash
cd chat-extension
npm install   # installs @types/vscode and other devDependencies
npm run build
```

---

### `npm run package` fails with "vsce not found"

**Cause:** `@vscode/vsce` is not installed.

**Solution:**
```bash
cd chat-extension
npm install   # installs @vscode/vsce
npm run package
```

---

### `npm run build:webview` is very slow

This is normal. Angular has many dependencies to compile. The first build can take 60–120 seconds. Subsequent builds are faster thanks to the cache.

---

## Python issues

### "Python not found" or "No Python interpreter found"

**Cause:** Python 3 is not installed or not in PATH.

**Solution:**
```bash
# Verify if Python is available
python3 --version   # macOS/Linux
python --version    # Windows

# If not available:
# macOS: brew install python3
# Linux: sudo apt install python3
# Windows: https://python.org/downloads
```

---

### Code execution fails with import errors

**Cause:** the package is not yet installed in Claudio's venv.

**Solution:** Claudio automatically installs common packages (matplotlib, numpy, pandas, scipy). For additional packages, add a `# pip install <package>` comment in the code — Claudio will see it and install the package.

Alternatively, install manually in the venv:
```bash
# Find the venv path (shown in the extension logs)
# Typically: ~/.config/Code/User/globalStorage/local.claudio/.claudio-venv
~/.config/Code/User/globalStorage/local.claudio/.claudio-venv/bin/pip install <package>
```

---

### matplotlib plot doesn't appear

**Expected behavior:** `plt.show()` is intercepted by Claudio and replaced with saving the plot as PNG. The plot is shown as an image in the chat.

**If the plot doesn't appear:**
1. Make sure the code calls `plt.show()` (not just `plt.savefig()`)
2. Check the extension logs for Python errors
3. Make sure matplotlib is installed in the venv

---

## How to see logs

### Extension host logs

1. In VS Code: **Help → Toggle Developer Tools**
2. Select the **Console** tab
3. Filter for "Claudio" to find relevant messages
4. Errors appear in red

### Proxy logs

**If started with `start_agent_cli.sh`:**
```bash
cat proxy/proxy.log
# or in real time:
tail -f proxy/proxy.log
```

**If started directly (`cd proxy && npm start`):**
Logs appear directly in the terminal.

**Debug mode** (detailed SSE logs):
In `proxy/.env.proxy`:
```env
DEBUG=1
```

---

## Unresolved problems

If the problem is not in this guide:

1. Check the extension logs (Developer Tools → Console)
2. Check the proxy logs (`proxy/proxy.log`)
3. Report the issue including:
   - Operating system and version
   - `node --version`
   - `code --version`
   - Relevant log output (extension and/or proxy)
   - Steps to reproduce

---

## Summary table

| Symptom | Likely cause | Quick fix |
|---------|-------------|-----------|
| Proxy does not start automatically | `claudio.proxyDir` not set | Add `"claudio.proxyDir": "${workspaceFolder}/proxy"` to VS Code settings |
| Proxy crashes at startup | `npm install` not run in `proxy/` | `cd proxy && npm install`, then reload VS Code |
| "Node.js not found" notification | Node.js not in VS Code PATH | Reinstall Node.js, restart VS Code |
| Red "Disconnected" indicator | Proxy not running | Reload VS Code (triggers auto-start), or `cd proxy && npm start` |
| Red indicator with proxy running | Wrong host/port settings | Check VS Code settings for `claudio` |
| `503 Proxy is still initializing` | Tool probe still in background | Wait 5–30s |
| Claudio icon missing | Extension not installed/activated | Check Extensions panel |
| Crash on activation | `dist/extension.js` missing | `npm run build && npm run package && code --install-extension ...` |
| Angular build fails | Webview deps missing | `cd src/webview-ui && npm install` |
| Extension build fails | Host deps missing | `cd chat-extension && npm install` |
| `vsce not found` | `@vscode/vsce` not installed | `npm install` in `chat-extension/` |
| "Python not found" | Python 3 not in PATH | Install Python 3.8+ from python.org |
| Plots not showing | `plt.show()` not called | Add `plt.show()` to the code |
| Panel blank | Webview not compiled | `npm run build` (compiles everything) |

---

## Related Docs

- [Quick Start](quick-start.md) — step-by-step installation
- [Architecture](architecture.md) — internal structure (useful to understand where to look for logs)
- [Proxy Quick Setup](../../proxy/docs/quick-setup.md) — proxy troubleshooting
