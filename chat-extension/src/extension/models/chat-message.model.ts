/**
 * chat-message.model.ts — Extension-side conversation message model.
 *
 * @module extension/models
 */

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}
