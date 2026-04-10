/**
 * activation.ts — VS Code extension entry point.
 *
 * Registers commands and initializes the extension.
 * If `claudio.proxyDir` is configured, ProxyManager spawns the proxy
 * process automatically and stops it when VS Code closes.
 *
 * @module extension
 */

import * as vscode from "vscode";
import { ChatSession } from "./chat-session";
import { SidebarProvider } from "./webview/sidebar-provider";
import { registerOpenChatCommand } from "./commands/open-chat.command";
import { ProxyManager } from "./proxy/proxy-manager";
import { loadVsCodeSettings, setProxyPortOverride } from "./config/extension-config";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const vsSettings = loadVsCodeSettings();

  // ── Optional proxy lifecycle management ──────────────────────────────────
  if (vsSettings.proxyDir && vsSettings.autoStartProxy) {
    const outputChannel = vscode.window.createOutputChannel("Claudio Proxy");
    context.subscriptions.push(outputChannel);

    const proxyManager = new ProxyManager(
      vsSettings.proxyDir,
      context.globalStoragePath,
      outputChannel,
    );
    // dispose() is called automatically when the extension is deactivated
    context.subscriptions.push(proxyManager);

    try {
      await proxyManager.start(vsSettings.proxyPort);
      // Override the port for this session so ChatSession uses the actual port
      setProxyPortOverride(proxyManager.actualPort);
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Claudio: could not start proxy — ${e}. Start it manually: cd proxy && npm start`,
      );
      // Non-fatal: ChatSession will try the configured port anyway
    }
  }

  // ── Chat session + sidebar ────────────────────────────────────────────────
  const session = new ChatSession(context.extensionUri, context.globalStoragePath);
  context.subscriptions.push(session);

  context.subscriptions.push(registerOpenChatCommand(context, session));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.VIEW_ID,
      new SidebarProvider(session, context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}

export function deactivate(): void {
  // Cleanup handled by disposables registered in context.subscriptions
}
