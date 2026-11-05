// @ts-check
/**
 * Deterministic thread titles. O(tokens) core path — no goal×recent cartesian product.
 */
import {
  MAX_CHARS,
  MAX_WORDS,
  cleanText,
  contentRuns,
  formatTitle,
  isUsefulLine,
  isKeptWord,
  splitCommands,
  stem,
  tokens,
} from "./text.js";

/** Candidates past this are only added when they come from a whole run. */
const MAX_CANDIDATES = 48;
/** Below this a phrase is noise, not a name. */
const MIN_SCORE = 2;

const PLACEHOLDER =
  /^(new thread|new plugin|agent|claude|codex|cursor-agent|kimi|terminal|untitled|thread)$/i;

/** Kagan titles a new thread after its program, sometimes with flags. */
const PROGRAM =
  /^(claude|codex|cursor-agent|kimi|opencode|gemini|aider|bash|zsh|sh|fish|pwsh|powershell|node|python3?)(\s|$)/i;

const PATH_NOISE =
  /^(src|lib|bin|dist|build|node_modules|crates|tests|personal|agent|users|home|tmp|var|private|library|application|support|contents|macos|kagan|env_[a-f0-9]+|thr_[a-f0-9]+|main|index|mod|test|spec)$/i;

/** Single-word titles too vague to recall a thread by. */
const VAGUE = new Set(
  "plugin plugins app apps board boards panel panels page pages tool tools file files folder folders project projects repo repos code update fix bug test tests rename name names naming auto new old".split(
    /\s+/,
  ),
);

/** Why a phrase was chosen. `better` is the only reason to rename. */
/** @typedef {"better" | "no-signal"} ProposalReason */

/**
 * Everything one proposal is built from, and the context its phrases are scored in.
 * @typedef {{ goal: Map<string, number>, recent: Map<string, number>,
 *   paths: Set<string>, contiguous?: boolean, goalText: string, recentText: string,
 *   goalWords: string[], recentWords: string[], pathWords: string[],
 *   maxWords: number, commands: string[], quotes: string[] }} Evidence
 */

/**
 * @param {string[]} paths
 * @returns {string[]} words a file name suggests, in reading order
 */
export function pathHints(paths) {
  /** @type {string[]} */
  const hints = [];
  for (const p of paths || []) {
    const parts = String(p).split(/[/\\]/).filter(Boolean);
    const file = (parts[parts.length - 1] || "").replace(/\.[a-z0-9]+$/i, "");
    for (const name of [file, ...parts.slice(-3, -1)]) {
      if (!name || PATH_NOISE.test(name)) continue;
      const words = tokens(name.replace(/[-_]+/g, " ")).slice(0, 2);
      if (words.length) hints.push(words.join(" "));
    }
  }
  return hints;
}

/**
 * @param {string[]} words
 */
function wordCounts(words) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const w of words) {
    const k = stem(w);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

/**
 * The words that appear most often, spelled as they were written.
 * @param {string[]} words
 * @param {number} limit
 */
function topWords(words, limit) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w);
}

/**
 * @param {string} phrase
 * @param {Evidence} ctx
 */
function scorePhrase(phrase, ctx) {
  const words = phrase.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > MAX_WORDS) return -Infinity;
  if (phrase.length > MAX_CHARS) return -Infinity;
  if (PLACEHOLDER.test(phrase)) return -Infinity;

  let score = 0;
  let goalHits = 0;
  let pathHits = 0;

  for (const w of words) {
    const f = stem(w);
    const g = ctx.goal.get(f) || 0;
    const r = ctx.recent.get(f) || 0;
    if (g) {
      goalHits++;
      score += 4 + Math.min(2, g);
    }
    if (r) score += 1.5 + Math.min(1.5, r);
    if (ctx.paths.has(f) || ctx.paths.has(w)) {
      pathHits++;
      score += 3;
    }
    if (w.length >= 5) score += 0.35;
  }

  const bridge = words.filter((w) => {
    const f = stem(w);
    return (ctx.goal.get(f) || 0) > 0 && (ctx.recent.get(f) || 0) > 0;
  }).length;
  score += bridge * 2;

  if (ctx.contiguous) score += 3.5;
  if (words.length === 3) score += 2.2;
  else if (words.length === 2) score += 1.8;
  else if (words.length === 4) score += 1.0;
  else score += 0.15;

  score += Math.max(0, (MAX_CHARS - phrase.length) / MAX_CHARS);
  if (goalHits === 0 && pathHits === 0) score -= 6;
  if (goalHits === 0 && pathHits > 0) score -= 0.5;
  // One vague word is not recallable in a sidebar full of threads.
  if (words.length === 1 && VAGUE.has(words[0])) score -= 8;
  if (words.length === 1 && words[0].length <= 4) score -= 1.5;
  return score;
}

/**
 * Add only the head/tail windows of a run — O(maxWords) per run, not O(n²).
 * @param {string[]} run
 * @param {number} maxWords
 * @param {(phrase: string, opts?: { contiguous?: boolean, boost?: number }) => void} add
 * @param {number} boost
 */
function addRunWindows(run, maxWords, add, boost) {
  const nMax = Math.min(maxWords, run.length);
  for (let n = nMax; n >= 1; n--) {
    add(run.slice(-n).join(" "), { contiguous: true, boost: boost + (n >= 2 ? 1.2 : 0) });
    if (run.length > n) add(run.slice(0, n).join(" "), { contiguous: true, boost: boost * 0.5 });
  }
}

/**
 * @param {string} text
 * @param {number} maxWords
 */
function quotedPhrases(text, maxWords) {
  /** @type {string[]} */
  const quotes = [];
  for (const m of text.matchAll(/["“']([^"”']{3,40})["”']/g)) {
    const q = tokens(m[1]).slice(0, maxWords).join(" ");
    if (q) quotes.push(q);
  }
  return quotes;
}

/**
 * What the evidence is made of, before any candidate is scored.
 * @param {{ goal?: string[], recent?: string[], paths?: string[], maxWords?: number }} input
 * @returns {Evidence}
 */
function readEvidence(input) {
  // Commands are pulled out before the short-line filter, so "/ship" survives.
  const { body, commands } = splitCommands((input.goal || []).join("\n"));
  const goalText = body
    .split("\n")
    .map((line) => cleanText(line))
    .filter(isUsefulLine)
    .join("\n");
  const recentText = (input.recent || [])
    .map((line) => cleanText(line))
    .filter(isUsefulLine)
    .join("\n");
  const goalTok = tokens(goalText);
  for (const command of commands) goalTok.push(command);
  const recentTok = tokens(recentText);
  const pathWords = pathHints(input.paths || []);
  const maxWords = Math.min(MAX_WORDS, Math.max(1, input.maxWords || MAX_WORDS));

  /** @type {Set<string>} */
  const pathSet = new Set();
  for (const h of pathWords) {
    for (const w of tokens(h)) pathSet.add(stem(w));
  }

  return {
    goal: wordCounts(goalTok),
    recent: wordCounts(recentTok),
    paths: pathSet,
    goalText,
    recentText,
    goalWords: goalTok,
    recentWords: recentTok,
    pathWords,
    maxWords,
    commands,
    quotes: quotedPhrases(`${goalText}\n${recentText}`, maxWords),
  };
}

/**
 * Every phrase worth scoring, with its best score.
 * @param {Evidence} ctx
 */
function collectCandidates(ctx) {
  /** @type {Map<string, { score: number, contiguous: boolean }>} */
  const candidates = new Map();

  const add = (
    phrase,
    /** @type {{ contiguous?: boolean, boost?: number }} */ opts = {},
  ) => {
    if (candidates.size >= MAX_CANDIDATES && !opts.contiguous) return;
    const t = formatTitle(phrase);
    const words = t.split(/\s+/).filter(Boolean);
    if (!t || words.length < 1 || words.length > ctx.maxWords) return;
    if (words.some((w) => !isKeptWord(w))) return;
    const base = scorePhrase(t, { ...ctx, contiguous: opts.contiguous });
    const total = base + (opts.boost || 0);
    const prev = candidates.get(t);
    if (!prev || total > prev.score) candidates.set(t, { score: total, contiguous: !!opts.contiguous });
  };

  for (const run of contentRuns(ctx.goalText)) addRunWindows(run, ctx.maxWords, add, 1);
  // A prompt that is only a command still names its work.
  for (const command of ctx.commands) addRunWindows([command], ctx.maxWords, add, 0.6);
  for (const run of contentRuns(ctx.recentText)) {
    if (run.some((w) => ctx.goal.has(stem(w)))) addRunWindows(run, ctx.maxWords, add, 0.5);
  }

  for (const quote of ctx.quotes) add(quote, { contiguous: true, boost: 1.2 });

  for (const h of ctx.pathWords) {
    add(h, { contiguous: false, boost: 1.0 });
    // new-plugin-7 → "new plugin" (drop trailing build numbers)
    const stripped = h.replace(/\s+\d+$/, "");
    if (stripped !== h) add(stripped, { contiguous: true, boost: 1.4 });
  }

  // Linear bridge: pair a top goal word with a top recent word, not a cartesian product.
  for (const g of topWords(ctx.goalWords, 4)) {
    for (const r of topWords(ctx.recentWords, 4)) {
      if (stem(g) !== stem(r)) add(`${g} ${r}`, { contiguous: false, boost: 0.3 });
    }
  }

  return candidates;
}

/**
 * @param {Map<string, { score: number, contiguous: boolean }>} candidates
 */
function rankCandidates(candidates) {
  return [...candidates.entries()]
    .map(([title, meta]) => ({ title, score: meta.score }))
    .filter((c) => c.score > MIN_SCORE)
    // Equal scores resolve by length, then alphabetically, so a name never flickers.
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.title.length - b.title.length ||
        (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
    );
}

/**
 * Prefer dropping a vague leading word when a suffix candidate is close in score.
 * @param {{ title: string, score: number }} best
 * @param {{ title: string, score: number }[]} ranked
 * @param {Evidence} ctx
 */
function dropVaguePrefix(best, ranked, ctx) {
  const parts = best.title.split(/\s+/);
  if (parts.length < 2 || !VAGUE.has(parts[0])) return best;
  const suffix = parts.slice(1).join(" ");
  const alt = ranked.find((c) => c.title === suffix);
  if (alt) return alt.score >= best.score - 4 ? alt : best;
  const forged = scorePhrase(suffix, { ...ctx, contiguous: true });
  return forged > MIN_SCORE && forged >= best.score - 4 ? { title: suffix, score: forged } : best;
}

/**
 * @param {{ goal?: string[], recent?: string[], paths?: string[], maxWords?: number }} input
 * @returns {{ title: string | null, reason: ProposalReason }}
 */
export function proposeTitle(input) {
  const ctx = readEvidence(input);
  const ranked = rankCandidates(collectCandidates(ctx));
  if (ranked.length === 0) return { title: null, reason: "no-signal" };
  const best = dropVaguePrefix(ranked[0], ranked, ctx);
  return { title: best.title, reason: "better" };
}

/**
 * True when a title is still the program line Kagan started the thread with,
 * or one word too vague to recall the thread by.
 * @param {string} title
 */
export function isPlaceholder(title) {
  const t = String(title || "").trim();
  if (!t) return true;
  if (PLACEHOLDER.test(t)) return true;
  if (PROGRAM.test(t)) return true;
  const words = formatTitle(t).split(/\s+/).filter(Boolean);
  if (words.length === 1 && VAGUE.has(words[0])) return true;
  return (
    t.length <= 24 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)?$/i.test(t) &&
    /agent|claude|codex|kimi|plugin|cursor/i.test(t)
  );
}
