/**
 * config.ts — Centralized configuration for the Anthropic-to-OpenAI proxy.
 *
 * Every tunable value in the proxy is parsed here from environment variables.
 * No other module should read process.env directly — all configuration
 * flows through the ProxyConfig interface.
 *
 * Default values are applied when environment variables are absent.
 * See .env.proxy for documentation of each variable.
 *
 * @module infrastructure/config
 */

import { Locale } from "../domain/types";

// ─────────────────────────────────────────────────────────────────────────────
// ProxyConfig Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete proxy configuration.
 *
 * Tightly coupled to the environment variable parsing logic in loadConfig().
 * Intentionally separate from types.ts — this interface belongs with its
 * factory function, not with the shared API type definitions.
 */
export interface ProxyConfig {
  // ── Server ──

  /** Port the proxy HTTP server listens on. */
  proxyPort: number;

  /** Full URL of the OpenAI-compatible chat completions endpoint. */
  targetUrl: string;

  /** When true, enables verbose SSE-level logging. */
  debug: boolean;

  // ── Tool Management ──

  /**
   * Maximum number of tools to send to the model per request.
   * null = auto-detect via binary search probe at startup.
   * 0 = disable filtering (send all tools as-is).
   */
  maxToolsOverride: number | null;

  /** Ordered list of core tool names that are always prioritized during selection. */
  coreTools: string[];

  // ── Tool Scoring Weights ──

  /** Additive score for tools listed in coreTools. */
  scoreCoreTools: number;

  /** Additive score for tools recently promoted via UseTool. */
  scorePromoted: number;

  /** Additive score for tools that appear in conversation history. */
  scoreUsedInHistory: number;

  /** Additive score for the tool forced by tool_choice (highest priority). */
  scoreForcedChoice: number;

  // ── Tool Probe ──

  /** Upper bound for the binary search probe (max tools to test). */
  probeUpperBound: number;

  /** max_tokens used in each probe request (keep low for speed). */
  probeMaxTokens: number;

  /** Timeout in milliseconds for each probe fetch request. */
  probeTimeout: number;

  // ── Tool Promotion ──

  /** Number of requests without use before a promoted tool decays. */
  promotionMaxAge: number;

  // ── UseTool Meta-Tool ──

  /** Maximum characters for each tool's description in the UseTool listing. */
  useToolDescMaxLength: number;

  // ── Model Limits ──

  /** Default max_tokens cap when model info is unavailable. */
  maxTokensFallback: number;

  /** maxTokensCap = loadedContextLength / this ratio. */
  contextToMaxTokensRatio: number;

  // ── i18n ──

  /** Locale for log messages and error strings. */
  locale: Locale;

  // ── Chat defaults (exposed via GET /config to chat clients) ──

  /** Default temperature for chat requests. */
  temperature: number;

  /** Optional system prompt prepended to every conversation. */
  systemPrompt: string;

  /** When true, send thinking:{type:"enabled"} to the model. */
  enableThinking: boolean;

  // ── Plan mode ──

  /**
   * Directory (relative to the workspace root) where plan files are written
   * in Plan mode. The agent writes `<workspaceCwd>/<plansDir>/<slug>.md`.
   * Configurable via the PLANS_DIR environment variable.
   */
  plansDir: string;

  // ── Agent loop ──

  /**
   * Hard cap on agentic loop iterations per turn. The proxy derives the
   * actual limit from the model's loaded context window and uses this value
   * only as an upper bound — set it low (e.g. 5) to force a strict limit
   * regardless of context size.
   */
  maxAgentIterations: number;

  // ── Python execution ──

  /**
   * Directory (relative to workspaceCwd) for the Python virtual environment
   * used by workspace action `python` and the `/v1/exec-python` endpoint.
   */
  pythonVenvDir: string;

  // ── Context compaction ──

  /**
   * When true, use an LLM summarization call to compress old conversation
   * history instead of naively dropping messages. Falls back to naive
   * trimming if the summarization call fails or times out.
   */
  semanticCompact: boolean;

  /** max_tokens budget for the summarization call. */
  summaryMaxTokens: number;

  /** Timeout in milliseconds for the summarization call. */
  summaryTimeout: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Values
// ─────────────────────────────────────────────────────────────────────────────

/** Default port chosen to avoid conflicts with LM Studio (1234), dev servers (8080), etc. */
const DEFAULT_PROXY_PORT = 5678;

/** Default LM Studio chat completions endpoint. */
const DEFAULT_TARGET_URL = "http://127.0.0.1:1234/v1/chat/completions";

/** Default core tools covering the essential coding workflow. */
const DEFAULT_CORE_TOOLS = "Bash,Read,Edit,Write,Glob,Grep";

/** Default score for tools in the CORE_TOOLS list. */
const DEFAULT_SCORE_CORE_TOOLS = 10;

/** Default score for tools promoted via UseTool. */
const DEFAULT_SCORE_PROMOTED = 8;

/** Default score for tools seen in conversation history. */
const DEFAULT_SCORE_USED_IN_HISTORY = 5;

/** Default score for tools forced by tool_choice. */
const DEFAULT_SCORE_FORCED_CHOICE = 20;

/** Default upper bound for the tool probe binary search. */
const DEFAULT_PROBE_UPPER_BOUND = 32;

/** Default max_tokens for probe requests (minimal to keep probes fast). */
const DEFAULT_PROBE_MAX_TOKENS = 100;

/** Default timeout for each probe fetch request (30 seconds). */
const DEFAULT_PROBE_TIMEOUT = 30_000;

/** Default number of requests before a promoted tool decays. */
const DEFAULT_PROMOTION_MAX_AGE = 10;

/** Default max characters per tool description in UseTool listing. */
const DEFAULT_USE_TOOL_DESC_MAX_LENGTH = 80;

/** Default max_tokens cap when model info cannot be fetched. */
const DEFAULT_MAX_TOKENS_FALLBACK = 4096;

/** Default ratio: maxTokensCap = contextLength / 4. */
const DEFAULT_CONTEXT_TO_MAX_TOKENS_RATIO = 4;

/** Default temperature for chat requests. */
const DEFAULT_TEMPERATURE = 0.7;

/** Default system prompt (empty). */
const DEFAULT_SYSTEM_PROMPT = "";

/** Default: send thinking:{type:"enabled"} when the model supports it. */
const DEFAULT_ENABLE_THINKING = true;

/** Default plans directory — relative to the workspace root. */
const DEFAULT_PLANS_DIR = ".claudio/plans";

/** Default Python venv directory — relative to the workspace root. */
const DEFAULT_PYTHON_VENV_DIR = ".claudio/python-venv";

/**
 * Hard cap on agentic loop iterations. The proxy derives the actual limit
 * from the model's context window (see computeMaxIterations in server.ts);
 * this value prevents runaway loops regardless of context size.
 */
const DEFAULT_MAX_AGENT_ITERATIONS = 40;

/** Default: use LLM-based semantic summarization for context compaction. */
const DEFAULT_SEMANTIC_COMPACT = true;

/** Default max_tokens for the summarization call. */
const DEFAULT_SUMMARY_MAX_TOKENS = 512;

/** Default timeout ms for the summarization call (15 seconds). */
const DEFAULT_SUMMARY_TIMEOUT = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a string environment variable with a fallback default.
 * @param key - Environment variable name.
 * @param fallback - Default value if the variable is not set.
 */
function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Read an integer environment variable with a fallback default.
 * @param key - Environment variable name.
 * @param fallback - Default numeric value if the variable is not set or unparseable.
 */
function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load and validate the proxy configuration from environment variables.
 *
 * Every configurable value is read here. Modules receive ProxyConfig
 * via constructor injection — they never access process.env directly.
 *
 * @returns Fully populated ProxyConfig with defaults applied.
 */
export function loadConfig(): ProxyConfig {
  const maxToolsRaw = process.env.MAX_TOOLS;

  return {
    // Server
    proxyPort:               envInt("PROXY_PORT", DEFAULT_PROXY_PORT),
    targetUrl:               env("TARGET_URL", DEFAULT_TARGET_URL),
    debug:                   env("DEBUG", "0") === "1",

    // Tool management
    maxToolsOverride:        maxToolsRaw !== undefined ? parseInt(maxToolsRaw, 10) : null,
    coreTools:               env("CORE_TOOLS", DEFAULT_CORE_TOOLS)
                               .split(",")
                               .map(s => s.trim())
                               .filter(Boolean),

    // Scoring weights
    scoreCoreTools:          envInt("SCORE_CORE_TOOLS", DEFAULT_SCORE_CORE_TOOLS),
    scorePromoted:           envInt("SCORE_PROMOTED", DEFAULT_SCORE_PROMOTED),
    scoreUsedInHistory:      envInt("SCORE_USED_IN_HISTORY", DEFAULT_SCORE_USED_IN_HISTORY),
    scoreForcedChoice:       envInt("SCORE_FORCED_CHOICE", DEFAULT_SCORE_FORCED_CHOICE),

    // Tool probe
    probeUpperBound:         envInt("PROBE_UPPER_BOUND", DEFAULT_PROBE_UPPER_BOUND),
    probeMaxTokens:          envInt("PROBE_MAX_TOKENS", DEFAULT_PROBE_MAX_TOKENS),
    probeTimeout:            envInt("PROBE_TIMEOUT", DEFAULT_PROBE_TIMEOUT),

    // Tool promotion
    promotionMaxAge:         envInt("PROMOTION_MAX_AGE", DEFAULT_PROMOTION_MAX_AGE),

    // UseTool
    useToolDescMaxLength:    envInt("USE_TOOL_DESC_MAX_LENGTH", DEFAULT_USE_TOOL_DESC_MAX_LENGTH),

    // Model limits
    maxTokensFallback:       envInt("MAX_TOKENS_FALLBACK", DEFAULT_MAX_TOKENS_FALLBACK),
    contextToMaxTokensRatio: envInt("CONTEXT_TO_MAX_TOKENS_RATIO", DEFAULT_CONTEXT_TO_MAX_TOKENS_RATIO),

    // i18n
    locale:                  env("LOCALE", Locale.EnUS) as Locale,

    // Chat defaults
    temperature:             envFloat("TEMPERATURE", DEFAULT_TEMPERATURE),
    systemPrompt:            env("SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT),
    enableThinking:          envBool("ENABLE_THINKING", DEFAULT_ENABLE_THINKING),

    // Plan mode
    plansDir:                env("PLANS_DIR", DEFAULT_PLANS_DIR),

    // Agent loop
    maxAgentIterations:      envInt("MAX_AGENT_ITERATIONS", DEFAULT_MAX_AGENT_ITERATIONS),

    // Python execution
    pythonVenvDir:           env("PYTHON_VENV_DIR", DEFAULT_PYTHON_VENV_DIR),

    // Context compaction
    semanticCompact:         envBool("SEMANTIC_COMPACT", DEFAULT_SEMANTIC_COMPACT),
    summaryMaxTokens:        envInt("SUMMARY_MAX_TOKENS", DEFAULT_SUMMARY_MAX_TOKENS),
    summaryTimeout:          envInt("SUMMARY_TIMEOUT", DEFAULT_SUMMARY_TIMEOUT),
  };
}
