/**
 * chat-panel.ts — Thin wrapper that opens a WebviewPanel and attaches it
 * to the shared ChatSession.
 *
 * @module extension/webview
 */

import * as vscode from "vscode";
import { getWebviewContent } from "./content-provider";
import type { ChatSession } from "../chat-session";

const VIEW_TYPE = "claudio.chatPanel";

export class ChatPanel {
  private static panel: vscode.WebviewPanel | null = null;

  static createOrShow(session: ChatSession, extensionUri: vscode.Uri): void {
    if (ChatPanel.panel) {
      ChatPanel.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Claudio",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "dist", "webview-ui"),
        ],
      },
    );

    ChatPanel.panel = panel;

    session.attachView(
      panel.webview,
      () => panel.dispose(),
      getWebviewContent(panel.webview, extensionUri),
    );

    panel.onDidDispose(() => {
      ChatPanel.panel = null;
      session.detachView();
    });
  }
}
