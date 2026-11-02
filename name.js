// @ts-check
/**
 * Deterministic thread titles. O(tokens) core path — no goal×recent cartesian product.
 */

const MAX_WORDS = 4;
const MAX_CHARS = 36;
const MIN_WORD = 3;
const MAX_CANDIDATES = 48;

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

const PLACEHOLDER =
  /^(new thread|new plugin|agent|claude|codex|cursor-agent|kimi|terminal|untitled|thread)$/i;

const NOISE_LINE =
  /^(?:\s*[❯$›>]\s|\s*…|\s*\.\.\.|Grepped|Read |Edited |Wrote |Running |Thinking|Waiting|Tool |Bash |Shell |function_calls)/i;

const PATH_NOISE =
  /^(src|lib|bin|dist|build|node_modules|crates|tests|personal|agent|users|home|tmp|var|private|library|application|support|contents|macos|kagan|env_[a-f0-9]+|thr_[a-f0-9]+|main|index|mod|test|spec)$/i;

/** Single-word titles too vague to recall a thread by. */
const VAGUE = new Set(
  "plugin plugins app apps board boards panel panels page pages tool tools file files folder folders project projects repo repos code update fix bug test tests rename name names naming auto new old".split(
    /\s+/,
  ),
);

/** Keep these hyphen compounds instead of splitting (STOP would eat "in"). */
const COMPOUND = new Set(["in-app", "end-to-end", "full-stack", "open-source", "real-time"]);

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
 * @param {string} text
 */
export function usefulLines(text) {
  return cleanText(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 8 && l.length < 240 && !NOISE_LINE.test(l));
}

/**
 * @param {string} word
 */
function keepWord(word) {
  if (word.length < MIN_WORD || word.length > 28) return false;
  if (STOP.has(word)) return false;
  if (/^\d+$/.test(word)) return false;
  if (/^[0-9a-f]{8,}$/i.test(word)) return false;
  if (/^thr_|^env_|^dev\./i.test(word)) return false;
  if (/\./.test(word)) return false;
  return /[a-z]/i.test(word);
}

/**
 * @param {string} text
 */
export function tokens(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9.+#-]+/i)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ""))
    .filter(keepWord);
}

/** @param {string} w */
function fold(w) {
  const base = w.replace(/[-_]+/g, "");
  if (base.length <= 4) return base;
  return base.replace(/(ing|tion|ments|ment|ers|ies|ied|ed|es|s)$/i, (m) => {
    if (m === "ies" || m === "ied") return "y";
    if (m === "es" || m === "s") return "";
    return "";
  });
}

/**
 * True when two titles are the same idea (hyphen/space/duplicate words).
 * @param {string} a
 * @param {string} b
 */
export function sameMeaning(a, b) {
  const na = formatTitle(a);
  const nb = formatTitle(b);
  return !!na && na === nb;
}

/**
 * @param {string} text
 * @returns {string[][]}
 */
function contentRuns(text) {
  let lowered = cleanText(text).toLowerCase().replace(/['’]/g, "");
  for (const c of COMPOUND) {
    lowered = lowered.split(c).join(c.replace(/-/g, "\u0000"));
  }
  const raw = lowered
    .replace(/[-_]+/g, " ")
    .replace(/\u0000/g, "-")
    .split(/[^a-z0-9.+#-]+/i)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ""))
    .filter((w) => {
      if (!w || /^\d+$/.test(w)) return false;
      if (w.includes("-")) return w.length >= MIN_WORD && /[a-z]/i.test(w);
      return w.length >= MIN_WORD && /[a-z]/i.test(w) && !STOP.has(w);
    });

  /** @type {string[][]} */
  const runs = [];
  /** @type {string[]} */
  let cur = [];
  for (const w of raw) {
    if (STOP.has(w) || /^thr_|^env_|^dev\./i.test(w) || /^[0-9a-f]{8,}$/i.test(w)) {
      if (cur.length) {
        runs.push(cur);
        cur = [];
      }
      continue;
    }
    cur.push(w);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/**
 * @param {string[]} paths
 */
export function pathHints(paths) {
  /** @type {string[]} */
  const hints = [];
  for (const p of paths || []) {
    const parts = String(p).split(/[/\\]/).filter(Boolean);
    const base = parts[parts.length - 1] || "";
    const stem = base.replace(/\.[a-z0-9]+$/i, "");
    if (keepWord(stem.toLowerCase().replace(/[-_]+/g, "")) || keepWord(stem.split(/[-_]/)[0] || "")) {
      if (!PATH_NOISE.test(stem)) hints.push(stem.replace(/[-_]+/g, " ").toLowerCase());
    }
    for (const part of parts.slice(-3, -1)) {
      if (!PATH_NOISE.test(part) && keepWord(part.toLowerCase().replace(/[-_]+/g, " ").split(/\s+/)[0] || "")) {
        hints.push(part.replace(/[-_]+/g, " ").toLowerCase());
      }
    }
  }
  return hints;
}

/**
 * @param {string[]} lines
 */
function zones(lines) {
  if (lines.length === 0) return { goal: [], recent: [] };
  const goalEnd = Math.max(1, Math.min(14, Math.ceil(lines.length * 0.3)));
  const recentStart = Math.max(goalEnd, lines.length - Math.max(8, Math.ceil(lines.length * 0.4)));
  return { goal: lines.slice(0, goalEnd), recent: lines.slice(recentStart) };
}

/**
 * @param {string[]} words
 */
function bag(words) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const w of words) {
    const k = fold(w);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

/**
 * @param {string} phrase
 * @param {{ goal: Map<string, number>, recent: Map<string, number>, paths: Set<string>, contiguous?: boolean }} ctx
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
    const f = fold(w);
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
    const f = fold(w);
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
  for (const w of raw
    .replace(/[-_]+/g, " ")
    .replace(/\u0000/g, "-")
    .split(/\s+/)
    .filter(Boolean)) {
    const token = w.includes("-") ? w : w;
    if (token.includes("-")) {
      const f = fold(token.replace(/-/g, ""));
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(token);
    } else {
      const f = fold(token);
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(token);
    }
    if (out.length >= MAX_WORDS) break;
  }
  return out.join(" ").slice(0, MAX_CHARS).trim();
}

/**
 * @param {string} title
 * @param {string} candidate
 */
function overlapRatio(title, candidate) {
  const a = new Set(tokens(title).map(fold));
  const b = tokens(candidate).map(fold);
  if (!a.size || !b.length) return 0;
  const hit = b.filter((w) => a.has(w)).length;
  return hit / Math.max(a.size, b.length);
}

/**
 * Add only the head/tail windows of a run — O(maxWords) per run, not O(n²).
 * @param {string[]} run
 * @param {number} maxWords
 * @param {(phrase: string, opts?: object) => void} add
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
 * @param {{ screen?: string, paths?: string[], currentTitle?: string, maxWords?: number }} input
 */
export function proposeTitle(input) {
  const screen = cleanText(input.screen || "");
  const lines = usefulLines(screen);
  const { goal, recent } = zones(lines);
  const pathWords = pathHints(input.paths || []);
  const goalTok = tokens(goal.join("\n"));
  const recentTok = tokens(recent.join("\n"));
  const maxWords = Math.min(MAX_WORDS, Math.max(1, input.maxWords || MAX_WORDS));

  const goalBag = bag(goalTok);
  const recentBag = bag(recentTok);
  /** @type {Set<string>} */
  const pathSet = new Set();
  for (const h of pathWords) {
    for (const w of tokens(h)) pathSet.add(fold(w));
  }

  /** @type {Map<string, { score: number, contiguous: boolean }>} */
  const candidates = new Map();

  const add = (phrase, opts = { contiguous: false, boost: 0 }) => {
    if (candidates.size >= MAX_CANDIDATES && !opts.contiguous) return;
    const t = formatTitle(phrase);
    const words = t.split(/\s+/).filter(Boolean);
    if (!t || words.length < 1 || words.length > maxWords) return;
    if (words.some((w) => !keepWord(w))) return;
    const base = scorePhrase(t, {
      goal: goalBag,
      recent: recentBag,
      paths: pathSet,
      contiguous: opts.contiguous,
    });
    const score = base + (opts.boost || 0);
    const prev = candidates.get(t);
    if (!prev || score > prev.score) candidates.set(t, { score, contiguous: !!opts.contiguous });
  };

  for (const run of contentRuns(goal.join("\n"))) addRunWindows(run, maxWords, add, 1);
  const goalFolds = goalBag;
  for (const run of contentRuns(recent.join("\n"))) {
    if (run.some((w) => goalFolds.has(fold(w)))) addRunWindows(run, maxWords, add, 0.5);
  }

  for (const m of screen.matchAll(/["“']([^"”']{3,40})["”']/g)) {
    const q = tokens(m[1]).slice(0, maxWords).join(" ");
    if (q) add(q, { contiguous: true, boost: 1.2 });
  }

  for (const h of pathWords) {
    add(h, { contiguous: false, boost: 1.0 });
    // new-plugin-7 → "new plugin" (drop trailing build numbers)
    const stripped = h.replace(/\s+\d+$/, "").replace(/-\d+$/, "");
    if (stripped !== h) add(stripped, { contiguous: true, boost: 1.4 });
  }

  // Linear bridge: pair top goal unigram with top recent unigram (not full cartesian).
  const topGoal = [...goalBag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const topRecent = [...recentBag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  for (const [g] of topGoal) {
    for (const [r] of topRecent) {
      if (g !== r) add(`${g} ${r}`, { contiguous: false, boost: 0.3 });
    }
  }

  if (input.currentTitle) {
    const cleaned = formatTitle(tokens(input.currentTitle).slice(0, maxWords).join(" "));
    if (cleaned) add(cleaned, { contiguous: true, boost: 2 });
  }

  const ranked = [...candidates.entries()]
    .map(([title, meta]) => ({ title, score: meta.score, contiguous: meta.contiguous }))
    .filter((c) => c.score > 2)
    .sort((a, b) => b.score - a.score || a.title.length - b.title.length);

  const fingerprint = fp(
    [
      goalTok.map(fold).slice(0, 24).join(" "),
      recentTok.map(fold).slice(-24).join(" "),
      pathWords.map((h) => formatTitle(h)).slice(0, 8).join(" "),
    ].join("|"),
  );

  if (ranked.length === 0) {
    return { title: null, score: 0, reason: "no-signal", fingerprint };
  }

  // Prefer dropping a vague leading word when a suffix candidate is close in score.
  let best = ranked[0];
  {
    const parts = best.title.split(/\s+/);
    if (parts.length >= 2 && VAGUE.has(parts[0])) {
      const suffix = parts.slice(1).join(" ");
      const alt = ranked.find((c) => c.title === suffix);
      if (alt && alt.score >= best.score - 4) best = alt;
      else if (!alt) {
        const forged = {
          title: suffix,
          score: scorePhrase(suffix, {
            goal: goalBag,
            recent: recentBag,
            paths: pathSet,
            contiguous: true,
          }),
          contiguous: true,
        };
        if (forged.score > 2 && forged.score >= best.score - 4) best = forged;
      }
    }
  }

  const current = (input.currentTitle || "").trim();

  // Hysteresis: never flip hyphen/space variants of the same meaning.
  if (current && sameMeaning(current, best.title)) {
    return { title: null, score: best.score, reason: "same-meaning", fingerprint };
  }

  const currentClean = formatTitle(tokens(current).slice(0, maxWords).join(" "));
  const rawWords = current ? current.split(/\s+/).filter(Boolean) : [];
  const cleanWords = current ? tokens(current) : [];
  const noisyCurrent =
    !!current &&
    rawWords.length >= 3 &&
    cleanWords.length <= Math.ceil(rawWords.length / 2);

  if (current && !isPlaceholder(current) && !noisyCurrent) {
    const currentScore = scorePhrase(currentClean || current.toLowerCase(), {
      goal: goalBag,
      recent: recentBag,
      paths: pathSet,
      contiguous: overlapRatio(current, goal.join(" ")) >= 0.5,
    });

    if (currentClean && sameMeaning(currentClean, best.title)) {
      return { title: null, score: best.score, reason: "current-good-enough", fingerprint };
    }

    if (overlapRatio(currentClean || current, best.title) >= 0.67 && (currentClean || "").length <= best.title.length + 2) {
      return { title: null, score: best.score, reason: "current-good-enough", fingerprint };
    }

    // Stronger margin before replacing a stable auto title.
    const clearer = best.score >= currentScore + 3.5;
    const shorterEasier =
      best.score >= currentScore + 1.0 &&
      best.title.length + 4 < current.length &&
      best.title.split(" ").length < tokens(current).length;

    if (!clearer && !shorterEasier) {
      return { title: null, score: best.score, reason: "current-good-enough", fingerprint };
    }
  }

  return {
    title: best.title,
    score: best.score,
    reason: "better",
    fingerprint,
  };
}

/**
 * @param {string} title
 */
export function isPlaceholder(title) {
  const t = title.trim();
  if (!t) return true;
  if (PLACEHOLDER.test(t)) return true;
  const words = formatTitle(t).split(/\s+/).filter(Boolean);
  if (words.length === 1 && VAGUE.has(words[0])) return true;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)?$/i.test(t) && t.length <= 16 && !/\s/.test(t)) {
    return /agent|claude|codex|kimi|plugin|cursor/i.test(t);
  }
  return false;
}

/** @param {string} s */
function fp(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
