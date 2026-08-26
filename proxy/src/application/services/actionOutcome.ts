/**
 * actionOutcome.ts — put an action's image in front of the model.
 *
 * A `python` action that draws a plot produces a PNG. Returning its base64 as
 * the tool-result string costs tens of thousands of tokens and teaches the
 * model nothing, so the image travels beside the text instead — as an image
 * part a vision model can actually look at.
 *
 * Where it can travel is decided by the wire format, not by taste:
 *
 * - `role: "tool"` takes a **string**. An image part there is rejected.
 * - Every tool result of an assistant turn must follow that turn with nothing
 *   wedged between them, so an image cannot be slipped in after the result
 *   that produced it — it goes after all of them, in a user message.
 * - Path B has no tool messages at all: its observation already *is* a user
 *   turn, so the image goes inside it.
 *
 * Both paths funnel through here so there is one answer to "where does the
 * image go", and both are covered by `test/actionOutcome.test.ts`.
 *
 * @module application/services/actionOutcome
 */

import type { ActionImage, ActionOutcome } from "../../domain/entities/workspaceAction";

/** One executed tool call: the id its result must quote, and what came back. */
export interface ToolCallOutcome {
  id: string;
  outcome: ActionOutcome;
}

/** Approximate decoded size of a base64 payload, in KB. */
function sizeKb(image: ActionImage): number {
  return Math.max(1, Math.round((image.data.length * 3) / 4 / 1024));
}

/**
 * The line that goes in the text the model reads, in place of the payload.
 *
 * It always says an image exists. A model that is told nothing answers about a
 * picture it never received, which reads exactly like a model that hallucinated
 * one — and `attached: false` is the ordinary case on a text-only model.
 *
 * When the figure was also written to disk the path goes in too, whether or not
 * the image is attached: it is the only handle the *user* has on a picture that
 * otherwise exists solely inside the conversation.
 */
function imageNotice(image: ActionImage, attached: boolean): string {
  const saved = image.savedPath ? `, saved to ${image.savedPath}` : "";
  const where = attached
    ? "attached as an image below"
    : image.savedPath
      ? "not attached: this model cannot see images — the file above is what the user can open"
      : "not attached: this model cannot see images — have the script save the figure to a file instead";
  return `[the action produced an image (${image.media_type}, ~${sizeKb(image)} KB)${saved} — ${where}]`;
}

/** An OpenAI image part holding the payload as a `data:` URI. */
function imagePart(image: ActionImage): any {
  return {
    type: "image_url",
    image_url: { url: `data:${image.media_type};base64,${image.data}` },
  };
}

/** Text for the model: the action's own output, plus the image notice if any. */
function textFor(outcome: ActionOutcome, visionCapable: boolean): string {
  if (!outcome.image) return outcome.text;
  const notice = imageNotice(outcome.image, visionCapable);
  return outcome.text ? `${outcome.text}\n${notice}` : notice;
}

/**
 * Path A — append one tool result per executed call, then the images.
 *
 * The order is the whole point: results first, in call order, then a single
 * user message carrying every image the batch produced. Interleaving would
 * separate a tool result from the assistant turn it answers, and the backend
 * rejects that — on the turns that drew something, and only on those.
 *
 * @param messages       Loop history, appended to in place.
 * @param results        Executed calls, in the order their calls were made.
 * @param visionCapable  Whether the loaded model can see images at all.
 */
export function appendNativeToolResults(
  messages: any[],
  results: ToolCallOutcome[],
  visionCapable: boolean,
): void {
  for (const { id, outcome } of results) {
    messages.push({
      role: "tool",
      tool_call_id: id,
      content: textFor(outcome, visionCapable),
    });
  }

  if (!visionCapable) return;

  const images = results
    .map((r) => r.outcome.image)
    .filter((img): img is ActionImage => img !== undefined);
  if (images.length === 0) return;

  messages.push({ role: "user", content: images.map(imagePart) });
}

/**
 * Path B — build the `<observation>` user turn for one action.
 *
 * With no image (or no way to see one) the content stays a plain string, which
 * is what every existing observation is and what the textual manual teaches the
 * model to expect. Only an image turns it into a content array.
 */
export function buildObservationMessage(outcome: ActionOutcome, visionCapable: boolean): any {
  const observation = `<observation>\n${textFor(outcome, visionCapable)}\n</observation>`;

  if (!outcome.image || !visionCapable) {
    return { role: "user", content: observation };
  }

  // Image first, matching how `requestTranslator` orders an attachment and its
  // caption on the way in.
  return {
    role: "user",
    content: [imagePart(outcome.image), { type: "text", text: observation }],
  };
}
