/**
 * workspaceAction.ts — Pure domain entities for the workspace tool.
 *
 * Contains the action enum, classification, argument shape, and OpenAI
 * tool schema descriptor. No file system, no I/O — these are value objects
 * and constants that both the application and the infrastructure layer
 * (executeAction) depend on.
 *
 * @module domain/entities/workspaceAction
 */

// ─────────────────────────────────────────────────────────────────────────────
// Action identifiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All workspace action names the LLM may invoke via the `workspace` tool.
 * Values match the strings in the OpenAI tool schema (WORKSPACE_TOOL_DEF).
 *
 * `ExitPlanMode` is a control action: it does not touch the workspace, it
 * signals to the proxy that the user wants to leave Plan mode and start
 * executing an existing plan. The agent loop intercepts it and emits a
 * `plan_mode_exit_suggestion` SSE event for the extension to handle.
 */
export enum WorkspaceAction {
  List         = "list",
  Read         = "read",
  Grep         = "grep",
  Glob         = "glob",
  Write        = "write",
  Edit         = "edit",
  Bash         = "bash",
  Python       = "python",
  ExitPlanMode = "exit_plan_mode",
}

/**
 * Classification of each action for the permission gate.
 * - ReadOnly actions are auto-executed.
 * - Destructive actions require user approval before execution
 *   (see proxy/docs/permission-protocol.md).
 * Control actions (ExitPlanMode) are NOT classified — they are intercepted
 * before reaching the classification check.
 */
export enum ActionClass {
  ReadOnly    = "read-only",
  Destructive = "destructive",
}

export const ACTION_CLASSIFICATION: Record<string, ActionClass> = {
  [WorkspaceAction.List]:   ActionClass.ReadOnly,
  [WorkspaceAction.Read]:   ActionClass.ReadOnly,
  [WorkspaceAction.Grep]:   ActionClass.ReadOnly,
  [WorkspaceAction.Glob]:   ActionClass.ReadOnly,
  [WorkspaceAction.Write]:  ActionClass.Destructive,
  [WorkspaceAction.Edit]:   ActionClass.Destructive,
  [WorkspaceAction.Bash]:   ActionClass.Destructive,
  [WorkspaceAction.Python]: ActionClass.Destructive,
};

// ─────────────────────────────────────────────────────────────────────────────
// Argument shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Arguments the model passes when calling the `workspace` tool. All fields
 * are optional except `action`: each action uses a different subset.
 */
export interface ActionArgs {
  action: string;
  path?: string;
  pattern?: string;
  include?: string;
  content?: string;     // for write: full file content
  old_string?: string;  // for edit: exact text to replace
  new_string?: string;  // for edit: replacement text
  cmd?: string;         // for bash
  [key: string]: string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI tool schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OpenAI tool definition for the workspace tool.
 * A single tool slot with an `action` discriminator keeps the tool count at 1,
 * which is safe even for models with low maxTools limits.
 */
export const WORKSPACE_TOOL_DEF = {
  type: "function",
  function: {
    name: "workspace",
    description: [
      "Access the current workspace. Available actions:",
      "  list             – list directory contents",
      "  read             – read a file",
      "  grep             – search for a regex pattern across files",
      "  glob             – find files matching a glob-style pattern",
      "  write            – create or overwrite a file  ⚠ requires user approval",
      "  edit             – replace exact text in a file ⚠ requires user approval",
      "  bash             – run a shell command (30s timeout) ⚠ requires user approval",
      "  python           – execute Python code in the workspace venv ⚠ requires user approval",
      "  exit_plan_mode   – signal that the user wants to leave Plan mode and",
      "                     start executing the existing plan. The proxy will",
      "                     prompt the user to confirm the mode switch. Only",
      "                     useful when agentMode = plan and the user is asking",
      "                     to proceed/implement rather than refine the plan.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: Object.values(WorkspaceAction),
          description: "Action to perform.",
        },
        path: {
          type: "string",
          description:
            "Path relative to the workspace root " +
            "(e.g. '.', 'src/components', 'package.json'). " +
            "Required for list, read, grep, write, and edit.",
        },
        pattern: {
          type: "string",
          description:
            "For grep: a regex pattern to search for. " +
            "For glob: a glob pattern (e.g. '**/*.ts', 'src/**/*.tsx').",
        },
        include: {
          type: "string",
          description:
            "For grep: a file name pattern to restrict the search " +
            "(e.g. '*.ts', '*.{ts,tsx}'). Optional.",
        },
        content: {
          type: "string",
          description: "For write: the complete text content to write to the file.",
        },
        old_string: {
          type: "string",
          description:
            "For edit: the exact string to find in the file " +
            "(must match character-for-character including whitespace).",
        },
        new_string: {
          type: "string",
          description: "For edit: the replacement string.",
        },
        cmd: {
          type: "string",
          description:
            "For bash: the shell command to execute. " +
            "Runs in the workspace root with a 30-second timeout. " +
            "Prefer specific read-only commands (wc, head, git log) over open-ended ones. " +
            "For python: the Python source code to execute in the workspace venv.",
        },
      },
      required: ["action"],
    },
  },
};
