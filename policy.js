// @ts-check
/**
 * The one decision per thread: name it once, or leave it.
 * Kagan keeps a title after the first rename, so there is no second chance.
 */
import { cleanText, splitCommands } from "./text.js";
import { isPlaceholder, pathHints, proposeTitle } from "./name.js";

/** bb titles a prompt only when it carries this many words; with one shot we wait for the same. */
export const MIN_EVIDENCE_WORDS = 5;

/**
 * Why a thread kept its title, or why it was named.
 * @typedef {import("./name.js").ProposalReason | "too-short" | "kept"} NameReason
 */

/**
 * bb spends a title on a prompt of 5+ words, a command, or real changed files.
 * A one-word "continue" must keep the thread's current title.
 * @param {string} prompt what the person said
 * @param {string[]} [paths] files the thread changed
 */
export function hasEnoughEvidence(prompt, paths = []) {
  const { body, commands } = splitCommands(prompt || "");
  if (commands.length) return true;
  const words = cleanText(body)
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (words.length >= MIN_EVIDENCE_WORDS) return true;
  return pathHints(paths || []).length > 0;
}

/** Kagan keeps a title after the first rename, and says so in this message (see PORT.md). */
export function isKeptTitleError(error) {
  return /title is kept/i.test(String(error));
}

/** Reasons that leave the thread's title alone for good. */
export function isFinalReason(reason) {
  return reason === "kept";
}

/**
 * @param {{ currentTitle?: string, autoTitle?: string | null, goal?: string[],
 *   recent?: string[], prompt?: string, paths?: string[], maxWords?: number }} input
 * @returns {{ title: string | null, reason: NameReason }}
 */
export function decideName(input) {
  const currentTitle = String(input.currentTitle || "");
  // The person renamed it in the window, which also keeps the title.
  if (input.autoTitle && currentTitle !== input.autoTitle) {
    return { title: null, reason: "kept" };
  }
  // bb only titles a thread whose name is still the program's placeholder.
  // Kagan keeps any other title anyway, so asking would be a doomed host call.
  if (!isPlaceholder(currentTitle)) return { title: null, reason: "kept" };
  if (!hasEnoughEvidence(input.prompt || "", input.paths || [])) {
    return { title: null, reason: "too-short" };
  }
  const proposal = proposeTitle({
    goal: input.goal || [],
    recent: input.recent || [],
    paths: input.paths || [],
    maxWords: input.maxWords,
  });
  return { title: proposal.title, reason: proposal.reason };
}
