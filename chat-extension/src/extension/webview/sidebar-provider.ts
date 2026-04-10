/**
 * sidebar-provider.ts — WebviewViewProvider that renders Claudio in the Activity Bar sidebar.
 *
 * Attaches to the shared ChatSession on resolveWebviewView.
 * Mutual exclusivity with ChatPanel is handled by ChatSession.attachView().
 *
 * @module extension/webview
 */

import * as vscode from "vscode";
import { getWebviewContent } from "./content-provider";
import type { ChatSession } from "../chat-session";

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly VIEW_ID = "claudio.sidebarView";

  constructor(
    private readonly session: ChatSession,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist", "webview-ui"),
      ],
    };

    this.session.attachView(
      webviewView.webview,
      () => webviewView.dispose(),
      getWebviewContent(webviewView.webview, this.extensionUri),
    );

    webviewView.onDidDispose(() => {
      this.session.detachView();
    });
  }
}
