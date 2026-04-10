import { ContentBlockType } from "../enums/content-block-type.enum";

export interface TextBlock {
  type: ContentBlockType.Text;
  text: string;
}

export interface ThinkingBlock {
  type: ContentBlockType.Thinking;
  thinking: string;
  isComplete: boolean;
  startedAt?: number;
  completedAt?: number;
}

export interface ImageBlock {
  type: ContentBlockType.Image;
  mimeType: string;
  data: string; // base64
  name: string;
}

export interface ToolUseBlock {
  type: ContentBlockType.ToolUse;
  id: string;
  toolName: string;
  /** Accumulated raw JSON string from input_json_delta events. */
  rawInput: string;
  /** Parsed once the block is complete (content_block_stop received). */
  parsedInput?: {
    action?: string;
    path?: string;
    pattern?: string;
    include?: string;
    [key: string]: string | undefined;
  };
  isComplete: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ImageBlock | ToolUseBlock;
