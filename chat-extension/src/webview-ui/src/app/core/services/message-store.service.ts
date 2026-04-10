import { Injectable, signal, computed } from "@angular/core";
import { VscodeApiService } from "./vscode-api.service";
import { MessageRole } from "../enums/message-role.enum";
import { MessageStatus } from "../enums/message-status.enum";
import { ContentBlockType } from "../enums/content-block-type.enum";
import type { ChatMessage } from "../models/chat-message.model";
import type { ContentBlock, TextBlock, ThinkingBlock, ImageBlock } from "../models/content-block.model";
import type { TokenUsage } from "../models/token-usage.model";
import type { Attachment } from "@shared/message-protocol";

const STATE_KEY = "chatMessages";

@Injectable({ providedIn: "root" })
export class MessageStoreService {
  private readonly _messages = signal<ChatMessage[]>([]);
  private readonly _isPending = signal(false);
  private readonly _codeStatus = signal<string | null>(null);
  readonly messages = this._messages.asReadonly();
  readonly isStreaming = computed(() =>
    this._messages().some((m) => m.status === MessageStatus.Streaming),
  );
  /** True between SendMessage and the first message_start SSE event. */
  readonly isPending = this._isPending.asReadonly();
  /** Human-readable status string while Python code is executing; null when idle. */
  readonly codeStatus = this._codeStatus.asReadonly();

  setWaiting(waiting: boolean): void {
    this._isPending.set(waiting);
  }

  setCodeStatus(status: string | null): void {
    this._codeStatus.set(status);
  }

  constructor(private readonly vscodeApi: VscodeApiService) {
    this.restoreState();
  }

  addUserMessage(content: string, attachments: Attachment[] = []): string {
    const id = generateId();
    const contentBlocks: ContentBlock[] = [];

    for (const att of attachments) {
      if (att.mimeType.startsWith("image/")) {
        const imgBlock: ImageBlock = {
          type: ContentBlockType.Image,
          mimeType: att.mimeType,
          data: att.data,
          name: att.name,
        };
        contentBlocks.push(imgBlock);
      }
      // Text files are embedded in the content string by the container — no separate block needed
    }

    if (content.trim()) {
      contentBlocks.push({ type: ContentBlockType.Text, text: content });
    }

    const msg: ChatMessage = {
      id,
      role: MessageRole.User,
      contentBlocks,
      status: MessageStatus.Complete,
      timestamp: Date.now(),
    };
    this._messages.update((msgs) => [...msgs, msg]);
    this.persistState();
    return id;
  }

  startAssistantMessage(model?: string, messageId?: string): string {
    const id = messageId ?? generateId();
    const msg: ChatMessage = {
      id,
      role: MessageRole.Assistant,
      contentBlocks: [],
      status: MessageStatus.Streaming,
      timestamp: Date.now(),
      model,
    };
    this._messages.update((msgs) => [...msgs, msg]);
    return id;
  }

  startThinkingBlock(messageId: string): void {
    this.updateMessage(messageId, (msg) => {
      const block: ThinkingBlock = {
        type: ContentBlockType.Thinking,
        thinking: "",
        isComplete: false,
        startedAt: Date.now(),
      };
      msg.contentBlocks = [...msg.contentBlocks, block];
    });
  }

  startTextBlock(messageId: string): void {
    this.updateMessage(messageId, (msg) => {
      const block: TextBlock = {
        type: ContentBlockType.Text,
        text: "",
      };
      msg.contentBlocks = [...msg.contentBlocks, block];
    });
  }

  appendTextDelta(messageId: string, text: string): void {
    this.updateMessage(messageId, (msg) => {
      const lastBlock = msg.contentBlocks[msg.contentBlocks.length - 1];
      if (lastBlock?.type === ContentBlockType.Text) {
        const updated = { ...lastBlock, text: lastBlock.text + text };
        msg.contentBlocks = [...msg.contentBlocks.slice(0, -1), updated];
      }
    });
  }

  appendThinkingDelta(messageId: string, thinking: string): void {
    this.updateMessage(messageId, (msg) => {
      const thinkingBlock = findLastThinkingBlock(msg.contentBlocks);
      if (thinkingBlock) {
        const idx = msg.contentBlocks.lastIndexOf(thinkingBlock);
        const updated = { ...thinkingBlock, thinking: thinkingBlock.thinking + thinking };
        msg.contentBlocks = [
          ...msg.contentBlocks.slice(0, idx),
          updated,
          ...msg.contentBlocks.slice(idx + 1),
        ];
      }
    });
  }

  completeContentBlock(messageId: string, blockIndex: number): void {
    this.updateMessage(messageId, (msg) => {
      const block = msg.contentBlocks[blockIndex];
      if (block?.type === ContentBlockType.Thinking) {
        const updated: ThinkingBlock = { ...block, isComplete: true, completedAt: Date.now() };
        msg.contentBlocks = [
          ...msg.contentBlocks.slice(0, blockIndex),
          updated,
          ...msg.contentBlocks.slice(blockIndex + 1),
        ];
      }
    });
  }

  updateTokenUsage(messageId: string, usage: Partial<TokenUsage>): void {
    this.updateMessage(messageId, (msg) => {
      msg.tokenUsage = {
        inputTokens: usage.inputTokens ?? msg.tokenUsage?.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? msg.tokenUsage?.outputTokens ?? 0,
      };
    });
  }

  updateStopReason(messageId: string, stopReason: string): void {
    this.updateMessage(messageId, (msg) => {
      msg.stopReason = stopReason;
    });
  }

  finalizeMessage(messageId: string, stopReason?: string): void {
    this.updateMessage(messageId, (msg) => {
      msg.status = MessageStatus.Complete;
      if (stopReason) {
        msg.stopReason = stopReason;
      }
    });
    this.persistState();
  }

  setMessageError(messageId: string, error: string): void {
    this.updateMessage(messageId, (msg) => {
      msg.status = MessageStatus.Error;
      msg.stopReason = error;
    });
    this.persistState();
  }

  /**
   * Display an immediate system-generated message (e.g. slash command result)
   * as an assistant bubble without invoking the LLM.
   * Token count and model name are intentionally omitted.
   */
  addSystemMessage(content: string): void {
    const id = this.startAssistantMessage();
    this.startTextBlock(id);
    this.appendTextDelta(id, content);
    this.finalizeMessage(id);
  }

  clearHistory(): void {
    this._messages.set([]);
    this.persistState();
  }

  /**
   * Restore conversation history received from the extension when switching views.
   * Rebuilds ChatMessage[] from the extension-side ConversationMessage[] format.
   */
  restoreHistory(messages: Array<{ role: "user" | "assistant"; content: string }>): void {
    const chatMessages: ChatMessage[] = messages.map((m) => ({
      id: generateId(),
      role: m.role === "user" ? MessageRole.User : MessageRole.Assistant,
      contentBlocks: [{ type: ContentBlockType.Text, text: m.content }],
      status: MessageStatus.Complete,
      timestamp: Date.now(),
    }));
    this._messages.set(chatMessages);
    this.persistState();
  }

  private updateMessage(id: string, updater: (msg: ChatMessage) => void): void {
    this._messages.update((msgs) => {
      const idx = msgs.findIndex((m) => m.id === id);
      if (idx === -1) return msgs;
      const copy = { ...msgs[idx] };
      updater(copy);
      return [...msgs.slice(0, idx), copy, ...msgs.slice(idx + 1)];
    });
  }

  private persistState(): void {
    this.vscodeApi.setState({ [STATE_KEY]: this._messages() });
  }

  private restoreState(): void {
    const state = this.vscodeApi.getState<Record<string, any>>();
    if (state?.[STATE_KEY]) {
      this._messages.set(state[STATE_KEY] as ChatMessage[]);
    }
  }
}

function generateId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function findLastThinkingBlock(blocks: ContentBlock[]): ThinkingBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === ContentBlockType.Thinking) {
      return blocks[i] as ThinkingBlock;
    }
  }
  return undefined;
}
