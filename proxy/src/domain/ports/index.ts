/**
 * ports/index.ts — Barrel export for all domain ports.
 *
 * Allows callers to `import { LlmClientPort, SseWriterPort, ... } from "domain/ports/"`
 * without knowing the individual file names. Each port is defined in its
 * own file for clarity and single-responsibility.
 *
 * @module domain/ports
 */

export type { LlmClientPort, LlmChatRequest, LlmChatResponse } from "./llmClientPort";
export type { SseWriterPort } from "./sseWriterPort";
export type { PlanFileRepositoryPort } from "./planFileRepositoryPort";
export type { PromptRepositoryPort } from "./promptRepositoryPort";
export { PromptKey } from "./promptRepositoryPort";
export type { ApprovalInteractorPort, ApprovalRequestParams } from "./approvalInteractorPort";
export type { ClockPort } from "./clockPort";
export type { LoggerPort, ILogger } from "./loggerPort";
