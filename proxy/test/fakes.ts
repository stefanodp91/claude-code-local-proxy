/**
 * fakes.ts — Shared test doubles for the translator suites.
 *
 * Not a test file: the runner's glob is `test/**\/*.test.ts`, so this is only
 * ever imported. It is still covered by `tsc --noEmit`, which is the point —
 * a fake that drifts out of shape with the interface it stands in for fails
 * the typecheck rather than silently testing nothing.
 *
 * @module test/fakes
 */

import type { ToolManager } from "../src/application/toolManager";
import type { ProxyConfig } from "../src/infrastructure/config";
import type { ILogger } from "../src/domain/ports";
import type { LoadedModelInfo, OpenAITool, ToolSelection } from "../src/domain/types";

/** Records what the translators asked the ToolManager to do. */
export interface ToolManagerFake {
  manager: ToolManager;
  /** Arguments of every selectTools() call, in order. */
  readonly selections: { tools: OpenAITool[]; forced: string | undefined }[];
  /** Names the fake should treat as the UseTool meta-tool. */
  readonly useToolNames: Set<string>;
  /** What rewriteUseToolCall() returns; null means "could not parse". */
  rewriteTo: { name: string; input: any } | null;
  /**
   * The raw argument strings rewriteUseToolCall() was handed, in order. The
   * real one JSON.parses this, so a test that only checks the returned name
   * proves nothing about what was accumulated — assert on this instead.
   */
  readonly rewriteCalls: string[];
}

/**
 * A ToolManager that passes tools through untouched and rewrites UseTool calls
 * to whatever the test asked for. Real selection logic has its own suite; these
 * tests are about translation, and a real ToolManager here would couple the two.
 */
export function toolManagerFake(): ToolManagerFake {
  const selections: { tools: OpenAITool[]; forced: string | undefined }[] = [];
  const useToolNames = new Set<string>(["UseTool"]);
  const rewriteCalls: string[] = [];

  const fake = {
    selections,
    useToolNames,
    rewriteCalls,
    rewriteTo: null as { name: string; input: any } | null,
    manager: {
      selectTools(tools: OpenAITool[], _messages: any[], forced?: string): ToolSelection {
        selections.push({ tools, forced });
        return { tools, overflow: [], useToolDef: null };
      },
      isUseToolCall: (name: string) => useToolNames.has(name),
      rewriteUseToolCall: (args: string) => {
        rewriteCalls.push(args);
        return fake.rewriteTo;
      },
      promoteUsedTool() { /* not exercised by the translators */ },
    } as unknown as ToolManager,
  };

  return fake;
}

/** Silent logger. The translators log freely; none of it is under test. */
export const silentLogger: ILogger = {
  info() {}, error() {}, warn() {}, dbg() {},
} as unknown as ILogger;

/** Config with only the fields the request translator reads. */
export function configFake(over: Partial<ProxyConfig> = {}): ProxyConfig {
  return { maxTokensFallback: 4096, ...over } as ProxyConfig;
}

/** Loaded-model info with only the fields the request translator reads. */
export function modelInfoFake(over: Partial<LoadedModelInfo> = {}): LoadedModelInfo {
  return {
    id: "local-model",
    maxTokensCap: 0,
    supportsThinking: false,
    ...over,
  } as LoadedModelInfo;
}
