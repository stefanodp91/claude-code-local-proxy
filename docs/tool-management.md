# Tool Management

> Dynamic tool selection, scoring, UseTool meta-tool, and promotion system.

## The Problem

Claude Code sends **20+ tool definitions** in every request (Bash, Read, Edit, Write, Glob, Grep, Agent, TodoWrite, WebSearch, WebFetch, etc.). Local LLMs often fail when presented with too many tools — they either:

1. Ignore the tools entirely and respond with plain text
2. Put malformed JSON in the content field instead of using structured `tool_calls`
3. Hallucinate tool names or parameters

Testing shows each model has a **hard limit** on how many tools it can handle reliably in structured mode. For example: Nemotron Cascade 30B = 7 tools, Qwen 3.5 35B = ~15 tools.

## The Solution

```
Claude Code sends 22 tools
         │
         v
+─────────────────────────────────+
│      ToolManager.selectTools()   │
│                                  │
│  1. Score each tool (additive)   │
│  2. Sort by score (descending)   │
│  3. Top (N-1) = active set       │
│  4. Remaining = overflow          │
│  5. Generate UseTool meta-tool    │
│     listing all overflow tools    │
│  6. Return active set + UseTool   │
+─────────────────┬────────────────+
                  │
                  v
      7 tools sent to LLM:
      [Bash, Read, Edit, Write, Glob, Grep, UseTool]
                  │
                  v
      LLM calls UseTool({tool_name: "Agent", parameters: {...}})
                  │
                  v
+─────────────────────────────────+
│   Proxy rewrites response:       │
│   UseTool(Agent) → Agent(...)    │
│   + promotes Agent for next req  │
+──────────────────────────────────+
                  │
                  v
      Claude Code sees: Agent({...})
      (never knows UseTool existed)
```

---

## Scoring Algorithm

Every tool receives an **additive score** based on four criteria. Scores stack — a core tool that appears in history gets `SCORE_CORE_TOOLS + SCORE_USED_IN_HISTORY`.

| Criterion | Weight | When Applied |
|---|---|---|
| **Forced choice** | `+20` | `tool_choice: { type: "tool", name: "X" }` forces tool X |
| **Core tool** | `+10` | Tool is in the `CORE_TOOLS` list (Bash, Read, Edit, Write, Glob, Grep) |
| **Promoted** | `+8` | Tool was recently invoked via UseTool and promoted |
| **Used in history** | `+5` | Tool appears in a `tool_use` block in the conversation |

### Scoring Example

Given `MAX_TOOLS=7`, `CORE_TOOLS=Bash,Read,Edit,Write,Glob,Grep`:

```
Tool             Core  Promoted  History  Forced   Total
─────────────────────────────────────────────────────────
Bash              10      -         5       -        15
Read              10      -         5       -        15
Edit              10      -         -       -        10
Write             10      -         -       -        10
Glob              10      -         -       -        10
Grep              10      -         -       -        10
Agent              -      8         5       -        13    ← promoted!
TodoWrite          -      -         5       -         5
WebSearch          -      -         -       -         0
WebFetch           -      -         -       -         0
NotebookEdit       -      -         -       -         0
... (12 more)      -      -         -       -         0
─────────────────────────────────────────────────────────

Sorted: Bash(15), Read(15), Agent(13), Edit(10), Write(10),
        Glob(10), Grep(10), TodoWrite(5), WebSearch(0), ...

Active set (top 6): Bash, Read, Agent, Edit, Write, Glob
UseTool (slot 7):   Lists Grep, TodoWrite, WebSearch, ...
```

Note how Agent (promoted + history = 13) displaced Grep (core only = 10) from the active set. The scoring system adapts to the conversation.

---

## Selection Flow

```
selectTools(allTools, messages, forcedToolName)
  │
  ├── allTools.length <= maxTools?
  │     YES → return all tools unchanged (no filtering needed)
  │
  ├── Extract tool names from conversation history
  │     Scan messages for tool_use blocks → Set<string>
  │
  ├── Age promotions
  │     For each promoted tool: age++
  │     If age > promotionMaxAge: remove from promoted map
  │
  ├── Score each tool
  │     score = 0
  │     + scoreForcedChoice  if tool_choice forces this tool
  │     + scoreCoreTools     if name is in coreTools list
  │     + scorePromoted      if name is in promoted map
  │     + scoreUsedInHistory if name is in history set
  │
  ├── Sort by score (descending, stable)
  │
  ├── Split
  │     coreSet  = scored[0 .. maxTools-2]   (top N-1 tools)
  │     overflow = scored[maxTools-1 .. end]  (remaining)
  │
  └── Build UseTool definition
        Lists all overflow tools with truncated descriptions
        Returns: { tools: [...coreSet, UseTool], overflow, useToolDef }
```

---

## UseTool Meta-Tool

When tool filtering is active, the proxy auto-generates a `UseTool` function definition and appends it as the last tool in every request. Its description dynamically lists all overflow tools.

### Generated Definition

```json
{
  "type": "function",
  "function": {
    "name": "UseTool",
    "description": "Invoke a tool not in your current set. Available:\n- Agent: Launch a new agent to handle complex...\n- TodoWrite: Use this tool to create and manage...\n- WebSearch: Search the web for information...\n\nSpecify tool_name and its parameters.",
    "parameters": {
      "type": "object",
      "properties": {
        "tool_name": {
          "type": "string",
          "description": "Exact name of the tool to invoke"
        },
        "parameters": {
          "type": "object",
          "description": "Parameters to pass to the tool"
        }
      },
      "required": ["tool_name", "parameters"]
    }
  }
}
```

### How the Model Invokes It

The LLM produces a tool call like:

```json
{
  "id": "call_abc123",
  "type": "function",
  "function": {
    "name": "UseTool",
    "arguments": "{\"tool_name\": \"Agent\", \"parameters\": {\"prompt\": \"Search for...\"}}"
  }
}
```

### What the Proxy Does

1. **Detects** the tool call name is `UseTool`
2. **Parses** the JSON arguments to extract `tool_name` and `parameters`
3. **Rewrites** the tool call as if the model called `Agent` directly
4. **Promotes** `Agent` in the ToolManager for future requests
5. **Returns** to Claude Code:

```json
{
  "type": "tool_use",
  "id": "call_abc123",
  "name": "Agent",
  "input": { "prompt": "Search for..." }
}
```

Claude Code never sees `UseTool` — it receives `Agent` as if the model had direct access to it.

---

## Promotion Lifecycle

When a tool is invoked via UseTool, it gets **promoted** — receiving a score bonus in future requests that may push it into the active set.

```
Request 1: Model calls UseTool(Agent)
            ├── Proxy rewrites → Agent({...})
            └── ToolManager.promoteUsedTool("Agent")
                promoted = { Agent: { age: 0 } }

Request 2: Scoring runs
            Agent gets +8 (scorePromoted) + potential +5 (history)
            Agent enters active set (displaces a lower-scored core tool)
            promoted = { Agent: { age: 1 } }

Request 3: Agent not used this turn
            promoted = { Agent: { age: 2 } }

...

Request 12: age > promotionMaxAge (10)
            Agent removed from promoted map
            Agent drops back to overflow (unless it has history score)
```

```
  UseTool(X)          Active set                Overflow
      │                                             │
      ├── Promote X ──> X enters active set         │
      │                 (displaces lowest scorer)    │
      │                        │                     │
      │                 age++ each request            │
      │                        │                     │
      │                 age > maxAge?                 │
      │                   YES ──────────────────────> X returns to overflow
      │                   NO  ──> stays in active set │
```

---

## Tool Probe — Auto-Detection

At startup (unless `MAX_TOOLS` is set), the `ToolProbe` determines the model's tool calling limit via binary search.

### Algorithm

```
detect(modelId):
  │
  ├── Test with 1 tool
  │     FAIL → model doesn't support tool calling at all → return 0
  │     PASS → proceed to binary search
  │
  └── Binary search: lo=1, hi=PROBE_UPPER_BOUND(32)
        │
        ├── mid = (lo + hi) / 2
        ├── Send request with mid dummy tools + tool_choice="required"
        │
        ├── Response has tool_calls array?
        │     YES → maxWorking = mid, lo = mid + 1
        │     NO  → hi = mid - 1
        │
        └── Repeat until lo > hi → return maxWorking
```

### Probe Request Details

Each probe request:
- **Non-streaming** (`stream: false`)
- **Dummy tools**: `probe_tool_0`, `probe_tool_1`, ..., each with a single string parameter
- **Message**: `"Call probe_tool_0 with x='test'"`
- **tool_choice**: `"required"` (forces the model to produce a tool call)
- **max_tokens**: 100 (minimal, for speed)

### Example Trace

```
Probing tool limit...
  16 tools → ❌
   8 tools → ❌
   4 tools → ✅
   6 tools → ✅
   7 tools → ✅
Max tools detected: 7
```

The binary search runs ~5 iterations (log2(32) = 5), each taking <1 second. Total probe time: ~3-5 seconds.

---

## End-to-End Example

Scenario: Claude Code session with Nemotron Cascade (max tools: 7).

```
┌─── Startup ──────────────────────────────────────────────────────────┐
│  ToolProbe detects: max tools = 7                                    │
│  ToolManager created with maxTools=7                                 │
│  CORE_TOOLS = [Bash, Read, Edit, Write, Glob, Grep]                 │
│  Promoted = {} (empty)                                               │
└──────────────────────────────────────────────────────────────────────┘

┌─── Request 1 ────────────────────────────────────────────────────────┐
│  Claude sends 22 tools                                               │
│  Scoring: all 6 core tools = 10, everything else = 0                 │
│  Active: [Bash, Read, Edit, Write, Glob, Grep, UseTool]             │
│  Overflow: [Agent, TodoWrite, WebSearch, ... 15 more]                │
│                                                                      │
│  Model responds: UseTool({tool_name: "Agent", parameters: {...}})    │
│  Proxy rewrites → Agent({...})                                       │
│  Proxy promotes Agent                                                │
│  Claude sees: Agent({...})                                           │
└──────────────────────────────────────────────────────────────────────┘

┌─── Request 2 ────────────────────────────────────────────────────────┐
│  Claude sends 22 tools (same set)                                    │
│  Scoring:                                                            │
│    Bash=15 (core:10 + history:5)                                     │
│    Read=15 (core:10 + history:5)                                     │
│    Agent=13 (promoted:8 + history:5)  ← entered active set!         │
│    Edit=10, Write=10, Glob=10                                        │
│  Active: [Bash, Read, Agent, Edit, Write, Glob, UseTool]            │
│  Overflow: [Grep, TodoWrite, WebSearch, ... 15 more]                 │
│           ^^^^^ Grep displaced by Agent!                             │
│                                                                      │
│  Model responds: Edit({...})                                         │
│  No UseTool call this turn.                                          │
│  Agent.age incremented to 1                                          │
└──────────────────────────────────────────────────────────────────────┘

┌─── Request 12 ───────────────────────────────────────────────────────┐
│  Agent.age = 11 > promotionMaxAge(10)                                │
│  Agent removed from promoted map                                     │
│  Agent score drops to 5 (history only) or 0 (if no longer in hist)  │
│  Grep returns to active set                                          │
│  Active: [Bash, Read, Edit, Write, Glob, Grep, UseTool]             │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Related Docs

- [Architecture](proxy-architecture.md) — hexagonal structure and request flow
- [Configuration](proxy-configuration.md) — all scoring weights and tool variables
- [Startup Scripts](startup-scripts.md) — start.sh and start_claude_code.sh
