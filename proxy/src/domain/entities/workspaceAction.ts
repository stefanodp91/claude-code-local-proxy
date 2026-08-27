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
  Todo         = "todo",
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
  // Read-only in the sense that matters: it takes no path. It writes the one
  // configured file under `.claudio/` and can be pointed nowhere else, so
  // gating it would be a modal per checked box for no protection at all.
  [WorkspaceAction.Todo]:   ActionClass.ReadOnly,
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
// Action results
// ─────────────────────────────────────────────────────────────────────────────

/** A base64 image an action produced — today only a `python` plot. */
export interface ActionImage {
  /** MIME type, e.g. `image/png`. */
  media_type: string;
  /** The payload, base64, without the `data:` prefix. */
  data: string;
  /**
   * Workspace-relative path the image was written to, when it was.
   *
   * The attached image is for the model; this is for the person, who cannot
   * see inside the conversation. Absent when saving is disabled or failed —
   * and a failure to save is reported in the text, never swallowed.
   */
  savedPath?: string;
}

/**
 * Where an action finds the things it needs on disk.
 *
 * Grouped rather than passed as a tail of positional strings: the loops carry
 * this through to `executeAction`, and the previous shape had already started
 * growing one parameter at a time.
 */
export interface ActionEnv {
  /** Workspace-relative Python venv directory. */
  venvDir?: string;
  /** Workspace-relative directory for saved figures. Empty disables saving. */
  plotDir?: string;
  /** Workspace-relative todo list. Empty disables the action. */
  todoFile?: string;
}

/**
 * What an action gives back.
 *
 * `text` is what the model reads; it is always present, because every caller
 * needs something to put in a tool result or an `<observation>`. `image` is
 * the picture itself, kept out of `text` on purpose: base64 in a text field is
 * tens of thousands of tokens the model cannot read and pays for anyway, which
 * is exactly what this type exists to stop.
 */
export interface ActionOutcome {
  text: string;
  image?: ActionImage;
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
          description:
            "For write: the complete text content to write to the file. " +
            "For todo: the complete task list in markdown, replacing the previous one " +
            "(e.g. \"- [x] read the file\\n- [ ] change it\").",
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
