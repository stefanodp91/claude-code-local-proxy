/**
 * content-provider.ts — Generates the HTML shell for the Angular webview.
 *
 * Handles CSP nonce generation, asset URI resolution, and the
 * HTML template that bootstraps the Angular application.
 *
 * @module extension/webview
 */

import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as fs from "node:fs";

export function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const nonce = crypto.randomBytes(16).toString("hex");

  const distUri = vscode.Uri.joinPath(extensionUri, "dist", "webview-ui", "browser");
  const distPath = distUri.fsPath;

  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "main.js"));
  const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "styles.css"));

  // Angular 19 uses ES modules with dynamic import() for chunks.
  // Only main.js is loaded statically (type="module"); chunks are resolved automatically.
  // The import map below remaps bare chunk paths to their webview URIs so that
  // Angular's dynamic import() calls resolve correctly inside the webview sandbox.
  const chunkFiles = fs.readdirSync(distPath).filter((f) => f.startsWith("chunk-") && f.endsWith(".js"));
  const importMapEntries = chunkFiles
    .map((f) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, f));
      return `    "./${f}": "${uri}"`;
    })
    .join(",\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      font-src ${webview.cspSource};
      img-src ${webview.cspSource} data:;
      script-src 'nonce-${nonce}' ${webview.cspSource};
      connect-src http://127.0.0.1:* http://localhost:*;">
  <script nonce="${nonce}" type="importmap">
  { "imports": {
${importMapEntries}
  }}
  </script>
  <link rel="stylesheet" href="${stylesUri}">
  <title>Claudio</title>
</head>
<body>
  <app-root></app-root>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
