// @ts-check
/**
 * Text handling for thread titles: cleaning, tokens, word sets, runs.
 * Nothing here knows about a thread, a host, or a score.
 */

export const MAX_WORDS = 4;
export const MAX_CHARS = 36;
const MIN_WORD = 3;

/** @type {Set<string>} */
const STOP = new Set(
  `
  a an the and or but if then else when while for to of in on at by from with
  into over under after before about as is are was were be been being do does did
  done doing have has had having will would could should may might must can
  this that these those it its they them their you your we our i me my
  not no yes so just also only very more most less least much many any some
  other another each every all both few such than too own same
  please thanks thank hey hi hello ok okay sure right well now here there
  let make get set use run try need want help show find look see check
  create add update fix change remove delete write read open close start stop
  install installing installed
  implement implementing implements using used based like looks seems seem
  keep keeps keeping
  code codes line lines error errors
  output input result results test tests todo something anything everything
  working work works worked available based overall latest state given moment
  clearer shorter easier quickly recall words word set sets available
  periodically refresh refreshes refreshing sidebar those those must
  efficient clever deterministic techniques technique based
  agent agents claude codex cursor kimi model models prompt prompts
  truncated hidden expand review ctrl lines seconds ms json true false null
  kagan kg gpui personal caution folder folders worktree worktrees
  environment environments users user home tmp temp var private
  library application support contents macos
  `.trim().split(/\s+/),
);

const NOISE_LINE =
  /^(?:\s*[❯$›>]\s|\s*…|\s*\.\.\.|Grepped|Read |Edited |Wrote |Running |Thinking|Waiting|Tool |Bash |Shell |function_calls)/i;

/** Keep these hyphen compounds instead of splitting (STOP would eat "in"). */
const COMPOUND = new Set(["in-app", "end-to-end", "full-stack", "open-source", "real-time"]);

const COMMAND_LINE = /^\s*[/$]([a-z][a-z0-9-]{1,30})\b/i;

/**
 * @param {string} text
 */
export function cleanText(text) {
  return String(text || "")
    .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * One line of evidence worth reading.
 * @param {string} line
 */
export function isUsefulLine(line) {
  const t = line.trim();
  return t.length >= 8 && t.length < 240 && !NOISE_LINE.test(t);
}

/**
 * bb titles the work a slash command is applied to, not the command token.
 * Commands lead a line; a path like `src/name.js` is not a command.
 * @param {string} text
 */
export function splitCommands(text) {
  /** @type {string[]} */
  const commands = [];
  const body = cleanText(text)
    .split("\n")
    .map((line) => {
      let rest = line;
      for (;;) {
        const m = rest.match(COMMAND_LINE);
        if (!m) return rest;
        commands.push(m[1].toLowerCase());
        rest = rest.slice(m[0].length);
      }
    })
    .join("\n");
  return { body, commands: [...new Set(commands)] };
}

/**
 * @param {string} word
 */
export function isKeptWord(word) {
  if (word.length < MIN_WORD || word.length > 28) return false;
  if (STOP.has(word)) return false;
  if (/^\d+$/.test(word)) return false;
  if (/^[0-9a-f]{8,}$/i.test(word)) return false;
  if (/^thr_|^env_|^dev\./i.test(word)) return false;
  // The prefix of an id, once the separator has been split away.
  if (/^(thr|env|dev)$/i.test(word)) return false;
  if (/\./.test(word)) return false;
  return /[a-z]/i.test(word);
}

/** A generated id is not a word a person can recall a thread by. */
const GENERATED = /^(thr_|env_|dev\.)|^[0-9a-f]{8,}$/i;

/**
 * @param {string} word
 */
function endsARun(word) {
  return STOP.has(word) || GENERATED.test(word);
}

/**
 * Split text into the words a title can be built from, in order.
 * One pipeline for tokens, runs and file names.
 * @param {string} text
 * @returns {string[]}
 */
function splitWords(text) {
  let lowered = cleanText(text).toLowerCase().replace(/['’]/g, "");
  for (const c of COMPOUND) {
    lowered = lowered.split(c).join(c.replace(/-/g, "\u0000"));
  }
  return lowered
    .replace(/[-_]+/g, " ")
    .replace(/\u0000/g, "-")
    .split(/[^a-z0-9.+#-]+/i)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ""))
    .filter((w) => isKeptWord(w.replace(/-/g, "")));
}

/**
 * @param {string} text
 */
export function tokens(text) {
  return splitWords(text);
}

/**
 * Strip a common English ending so variants of a word share one key.
 * Crude on purpose: it only has to be stable, not linguistically right.
 * @param {string} w
 */
export function stem(w) {
  const base = w.replace(/[-_]+/g, "");
  if (base.length <= 4) return base;
  return base.replace(/(ing|tion|ments|ment|ers|ies|ied|ed|es|s)$/i, (m) =>
    m === "ies" || m === "ied" ? "y" : "",
  );
}

/**
 * @param {string} phrase
 */
export function formatTitle(phrase) {
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  // Protect known compounds, then split remaining hyphens.
  let raw = String(phrase).toLowerCase();
  for (const c of COMPOUND) {
    raw = raw.split(c).join(c.replace(/-/g, "\u0000"));
  }
  for (const token of raw
    .replace(/[-_]+/g, " ")
    .replace(/\u0000/g, "-")
    .split(/\s+/)
    .filter(Boolean)) {
    if (out.length >= MAX_WORDS) break;
    const f = stem(token);
    if (seen.has(f)) continue;
    const next = out.length ? `${out.join(" ")} ${token}` : token;
    // Stop at the boundary; only a single oversized word is ever cut.
    if (next.length > MAX_CHARS) {
      if (out.length === 0) out.push(token.slice(0, MAX_CHARS));
      break;
    }
    seen.add(f);
    out.push(token);
  }
  return out.join(" ");
}

/**
 * Runs of content words, broken at stop words, ids and line ends.
 * @param {string} text
 * @returns {string[][]}
 */
export function contentRuns(text) {
  /** @type {string[][]} */
  const runs = [];
  for (const line of cleanText(text).split("\n")) {
    /** @type {string[]} */
    let cur = [];
    for (const word of splitWords(line)) {
      if (endsARun(word)) {
        if (cur.length) runs.push(cur);
        cur = [];
        continue;
      }
      cur.push(word);
    }
    if (cur.length) runs.push(cur);
  }
  return runs;
}
