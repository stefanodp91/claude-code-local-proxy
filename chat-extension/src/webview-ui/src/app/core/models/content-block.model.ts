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

export type ContentBlock = TextBlock | ThinkingBlock | ImageBlock;
