/**
 * webview-bridge.ts — Bidirectional message bridge between extension and webview.
 *
 * Listens for messages from the webview and dispatches to handlers.
 * Provides typed send() for extension → webview communication.
 *
 * @module extension/webview
 */

import * as vscode from "vscode";
import {
  ToWebviewType,
  ToExtensionType,
  type ToWebviewMessage,
  type ToExtensionMessage,
} from "../../shared/message-protocol";

export type MessageHandler = (message: ToExtensionMessage) => void | Promise<void>;

export class WebviewBridge implements vscode.Disposable {
  private readonly handlers = new Map<ToExtensionType, MessageHandler>();
  private readonly disposable: vscode.Disposable;

  constructor(private readonly webview: vscode.Webview) {
    this.disposable = webview.onDidReceiveMessage((msg: ToExtensionMessage) => {
      const handler = this.handlers.get(msg.type);
      if (handler) {
        Promise.resolve(handler(msg)).catch((err) => {
          console.error(`[WebviewBridge] Handler error for ${msg.type}:`, err);
        });
      }
    });
  }

  on(type: ToExtensionType, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  send(message: ToWebviewMessage): void {
    this.webview.postMessage(message);
  }

  dispose(): void {
    this.disposable.dispose();
    this.handlers.clear();
  }
}
