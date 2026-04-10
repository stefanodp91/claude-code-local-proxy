/**
 * open-chat.command.ts — Command handler to open the chat panel.
 *
 * @module extension/commands
 */

import * as vscode from "vscode";
import { ChatPanel } from "../webview/chat-panel";
import type { ChatSession } from "../chat-session";

export function registerOpenChatCommand(
  context: vscode.ExtensionContext,
  session: ChatSession,
): vscode.Disposable {
  return vscode.commands.registerCommand("claudio.openChat", () => {
    ChatPanel.createOrShow(session, context.extensionUri);
  });
}
