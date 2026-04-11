/**
 * extension-config.ts — Typed wrapper around VS Code workspace configuration.
 *
 * VS Code settings provide only the connection params (proxyHost / proxyPort).
 * All runtime defaults (temperature, systemPrompt, enableThinking,
 * maxTokensFallback, locale, model info) are fetched from the proxy's
 * GET /config endpoint and merged into ChatConfig.
 *
 * @module extension/config
 */

import * as vscode from "vscode";
import type { AgentMode } from "../../shared/message-protocol";

const SECTION = "claudio";

// ── Proxy remote config (from GET /config) ─────────────────────────────────

export interface ProxyModelInfo {
  id: string;
  type: string;
  publisher: string;
  arch: string;
  quantization: string;
  compatibilityType: string;
  loadedContextLength: number;
  maxContextLength: number;
  maxTokensCap: number;
  /** Probe-derived: true iff the tool-limit probe succeeded (maxTools > 0). */
  supportsTools: boolean;
  /** Probe-derived: true iff the model produces reasoning_content on request. */
  supportsThinking: boolean;
  /** Probe-derived: true iff `enable_thinking: false` suppresses reasoning. */
  thinkingCanBeDisabled: boolean;
}

export interface ProxyRemoteConfig {
  proxyPort: number;
  targetUrl: string;
  maxTokensFallback: number;
  locale: string;
  temperature: number;
  systemPrompt: string;
  enableThinking: boolean;
  agentMode: AgentMode;
  model: ProxyModelInfo | null;
}

// ── Chat config (merged) ────────────────────────────────────────────────────

export interface ChatConfig {
  proxyHost: string;
  proxyPort: number;
  temperature: number;
  systemPrompt: string;
  enableThinking: boolean;
  /** Effective max_tokens: proxy model cap → proxy fallback → hard default. */
  maxTokens: number;
  locale: string;
  /** Current agent gating mode. Kept in sync with the proxy state. */
  agentMode: AgentMode;
  /** Model info fetched from the proxy, null if proxy is unreachable. */
  modelInfo: ProxyModelInfo | null;
}

// ── VS Code settings (connection + lifecycle) ───────────────────────────────

export interface VsCodeSettings {
  proxyHost: string;
  proxyPort: number;
  /** Absolute path to the proxy/ directory. Empty = external proxy. */
  proxyDir: string;
  /** When true, ProxyManager starts/stops the proxy automatically. */
  autoStartProxy: boolean;
}

/**
 * Overrides the proxy port used by loadVsCodeSettings().
 * Called by activation.ts after ProxyManager discovers the actual port.
 * The override persists for the extension's lifetime — it is never written
 * to any settings file.
 */
let _proxyPortOverride: number | undefined;

export function setProxyPortOverride(port: number): void {
  _proxyPortOverride = port;
}

export function loadVsCodeSettings(): VsCodeSettings {
  const cfg = vscode.workspace.getConfiguration(SECTION);

  let proxyDir = cfg.get<string>("proxyDir", "");
  // Resolve ${workspaceFolder} so teams can use it in .vscode/settings.json
  if (proxyDir.includes("${workspaceFolder}")) {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    proxyDir = proxyDir.replace(/\$\{workspaceFolder\}/g, wsFolder);
  }

  return {
    proxyHost: cfg.get<string>("proxyHost", "http://127.0.0.1"),
    proxyPort: _proxyPortOverride ?? cfg.get<number>("proxyPort", 5678),
    proxyDir,
    autoStartProxy: cfg.get<boolean>("autoStartProxy", true),
  };
}

// ── Proxy remote config fetch ───────────────────────────────────────────────

export async function fetchProxyConfig(baseUrl: string): Promise<ProxyRemoteConfig | null> {
  try {
    const res = await fetch(`${baseUrl}/config`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as ProxyRemoteConfig;
  } catch {
    return null;
  }
}

// ── Config merging ──────────────────────────────────────────────────────────

export function buildChatConfig(
  vs: VsCodeSettings,
  remote: ProxyRemoteConfig | null,
): ChatConfig {
  return {
    proxyHost:      vs.proxyHost,
    proxyPort:      vs.proxyPort,
    temperature:    remote?.temperature    ?? 0.7,
    systemPrompt:   remote?.systemPrompt   ?? "",
    enableThinking: remote?.enableThinking ?? true,
    maxTokens:      remote?.model?.maxTokensCap ?? remote?.maxTokensFallback ?? 4096,
    locale:         remote?.locale         ?? "en",
    agentMode:      remote?.agentMode      ?? "ask",
    modelInfo:      remote?.model          ?? null,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function proxyBaseUrl(config: Pick<ChatConfig, "proxyHost" | "proxyPort">): string {
  return `${config.proxyHost}:${config.proxyPort}`;
}
