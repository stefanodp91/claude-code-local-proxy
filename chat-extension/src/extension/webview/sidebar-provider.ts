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
      // A WebviewView has no dispose() — unlike a WebviewPanel, a view in the
      // Activity Bar cannot be closed programmatically. There is nothing to
      // tear down from our side, so the handle is a no-op here.
      () => {},
      getWebviewContent(webviewView.webview, this.extensionUri),
    );

    webviewView.onDidDispose(() => {
      this.session.detachView();
    });
  }
}
