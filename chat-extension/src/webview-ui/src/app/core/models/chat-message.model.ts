import { MessageRole } from "../enums/message-role.enum";
import { MessageStatus } from "../enums/message-status.enum";
import type { ContentBlock } from "./content-block.model";
import type { TokenUsage } from "./token-usage.model";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  contentBlocks: ContentBlock[];
  status: MessageStatus;
  timestamp: number;
  model?: string;
  tokenUsage?: TokenUsage;
  stopReason?: string;
}
