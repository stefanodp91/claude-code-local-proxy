/**
 * planExitInjection.ts — hand an approved plan back to the model.
 *
 * When the user leaves plan mode, Claudio re-runs the turn with the plan's path
 * in `x-plan-exit-path`. This is what that path turns into: the plan's text, in
 * front of the message the user originally sent, with a line saying what it is
 * for.
 *
 * It lives here rather than in `server.ts` because all three of its rules were
 * wrong there and none of them was visible:
 *
 * - **Containment.** The check was `startsWith(workspaceCwd)`, which passes for
 *   a sibling that merely shares the prefix — `/ws-evil/secret.md` against a
 *   workspace of `/ws`. The header is client-supplied, so that is any readable
 *   file, quoted into the prompt. Fourth time in this repo; `relative()` is the
 *   rule.
 * - **Shape.** Only a string `content` was handled. Claudio sends an array of
 *   blocks whenever the message carries an attachment, so approving a plan with
 *   a file attached ran the turn with no plan at all, silently.
 * - **Purpose.** The plan was prepended with no instruction. Measured against
 *   the live model: it read the plan and explained it back, changing nothing —
 *   which is exactly what the user approved their way out of.
 *
 * @module application/services/planExitInjection
 */

import { readFileSync } from "node:fs";
import { safeResolvePath } from "../../infrastructure/workspaceActions";

/** What the model is told the plan is for. */
function planPreamble(planPath: string): string {
  return (
    `[The user reviewed and approved the plan below, and has left plan mode. ` +
    `Execute it now — do not restate it, and do not plan again. ` +
    `The plan lives at \`${planPath}\`; update it there if the work makes it wrong.]`
  );
}

/** The full text put in front of the user's own message. */
function planBlock(planContent: string, planPath: string): string {
  return `${planPreamble(planPath)}\n\n${planContent.trim()}\n\n---\n\n`;
}

/**
 * Read the plan named by `x-plan-exit-path`, if it is inside the workspace.
 *
 * @returns the plan's text, or `null` when the path escapes the workspace or
 *          the file cannot be read. Never throws: a plan that cannot be found
 *          costs the injection, not the turn.
 */
export function loadPlanForExit(planPath: string, workspaceCwd: string): string | null {
  const safe = safeResolvePath(planPath.replace(/\\/g, "/"), workspaceCwd);
  if (!safe) return null;
  try {
    return readFileSync(safe, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Put the plan in front of the last user message, in place.
 *
 * @returns whether anything was injected — false when the conversation does not
 *          end with a user message, which means this is not a plan-exit turn.
 */
export function injectPlanIntoLastUserMessage(
  messages: any[],
  planContent: string,
  planPath: string,
): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "user") return false;

  const block = planBlock(planContent, planPath);

  if (typeof last.content === "string") {
    last.content = `${block}${last.content}`;
    return true;
  }

  if (Array.isArray(last.content)) {
    // Into the first text block, so an attachment stays where the model expects
    // it. With no text block at all, one is added rather than dropping the plan.
    const firstText = last.content.find((b: any) => typeof b?.text === "string");
    if (firstText) {
      firstText.text = `${block}${firstText.text}`;
    } else {
      last.content.push({ type: "text", text: block.trimEnd() });
    }
    return true;
  }

  return false;
}
