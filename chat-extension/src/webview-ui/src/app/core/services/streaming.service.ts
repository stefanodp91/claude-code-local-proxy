import { Injectable, OnDestroy } from "@angular/core";
import { Subscription } from "rxjs";
import { WebviewBridgeService } from "./webview-bridge.service";
import { MessageStoreService } from "./message-store.service";
import { ContentBlockType } from "../enums/content-block-type.enum";
import type { StreamDeltaPayload } from "@shared/message-protocol";

const EVENT_MESSAGE_START = "message_start";
const EVENT_CONTENT_BLOCK_START = "content_block_start";
const EVENT_CONTENT_BLOCK_DELTA = "content_block_delta";
const EVENT_CONTENT_BLOCK_STOP = "content_block_stop";
const EVENT_MESSAGE_DELTA = "message_delta";
const EVENT_MESSAGE_STOP = "message_stop";
const DELTA_TEXT = "text_delta";
const DELTA_THINKING = "thinking_delta";

@Injectable({ providedIn: "root" })
export class StreamingService implements OnDestroy {
  private currentMessageId: string | null = null;
  private blockIndex = 0;
  private readonly subscriptions = new Subscription();

  constructor(
    private readonly bridge: WebviewBridgeService,
    private readonly store: MessageStoreService,
  ) {
    this.subscriptions.add(
      this.bridge.onStreamDelta().subscribe((payload) => this.processDelta(payload)),
    );
    this.subscriptions.add(
      this.bridge.onStreamEnd().subscribe(() => this.handleStreamEnd()),
    );
    this.subscriptions.add(
      this.bridge.onStreamError().subscribe((err) => this.handleStreamError(err.message)),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  private processDelta(payload: StreamDeltaPayload): void {
    switch (payload.eventType) {
      case EVENT_MESSAGE_START:
        this.handleMessageStart(payload);
        break;
      case EVENT_CONTENT_BLOCK_START:
        this.handleContentBlockStart(payload);
        break;
      case EVENT_CONTENT_BLOCK_DELTA:
        this.handleContentBlockDelta(payload);
        break;
      case EVENT_CONTENT_BLOCK_STOP:
        this.handleContentBlockStop(payload);
        break;
      case EVENT_MESSAGE_DELTA:
        this.handleMessageDelta(payload);
        break;
      case EVENT_MESSAGE_STOP:
        this.handleMessageStop();
        break;
    }
  }

  private handleMessageStart(payload: StreamDeltaPayload): void {
    this.store.setWaiting(false);
    const model = payload.message?.model;
    const messageId = payload.message?.id;
    this.currentMessageId = this.store.startAssistantMessage(model, messageId);
    this.blockIndex = 0;

    if (payload.message?.usage) {
      this.store.updateTokenUsage(this.currentMessageId, {
        inputTokens: payload.message.usage.input_tokens,
      });
    }
  }

  private handleContentBlockStart(payload: StreamDeltaPayload): void {
    if (!this.currentMessageId) return;

    const blockType = payload.content_block?.type;
    if (blockType === ContentBlockType.Thinking) {
      this.store.startThinkingBlock(this.currentMessageId);
    } else {
      this.store.startTextBlock(this.currentMessageId);
    }
  }

  private handleContentBlockDelta(payload: StreamDeltaPayload): void {
    if (!this.currentMessageId) return;

    const deltaType = payload.delta?.type;
    if (deltaType === DELTA_TEXT && payload.delta?.text) {
      this.store.appendTextDelta(this.currentMessageId, payload.delta.text);
    } else if (deltaType === DELTA_THINKING && payload.delta?.thinking) {
      this.store.appendThinkingDelta(this.currentMessageId, payload.delta.thinking);
    }
  }

  private handleContentBlockStop(payload: StreamDeltaPayload): void {
    if (!this.currentMessageId) return;
    const idx = payload.index ?? this.blockIndex;
    this.store.completeContentBlock(this.currentMessageId, idx);
    this.blockIndex++;
  }

  private handleMessageDelta(payload: StreamDeltaPayload): void {
    if (!this.currentMessageId) return;

    if (payload.usage?.output_tokens !== undefined) {
      this.store.updateTokenUsage(this.currentMessageId, {
        outputTokens: payload.usage.output_tokens,
      });
    }

    const stopReason = payload.delta?.stop_reason ?? payload.stop_reason;
    if (stopReason) {
      this.store.updateStopReason(this.currentMessageId, stopReason);
    }
  }

  private handleMessageStop(): void {
    if (!this.currentMessageId) return;
    this.store.finalizeMessage(this.currentMessageId);
    this.currentMessageId = null;
    this.blockIndex = 0;
  }

  private handleStreamEnd(): void {
    this.store.setWaiting(false);
    if (this.currentMessageId) {
      this.store.finalizeMessage(this.currentMessageId);
      this.currentMessageId = null;
      this.blockIndex = 0;
    }
  }

  private handleStreamError(message: string): void {
    this.store.setWaiting(false);
    if (this.currentMessageId) {
      this.store.setMessageError(this.currentMessageId, message);
      this.currentMessageId = null;
      this.blockIndex = 0;
    }
  }
}
