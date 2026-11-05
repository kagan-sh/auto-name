// @ts-check
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { KgButton } from "gpui-component";
import { log, settings, toast } from "kagan/host";
import { next, reply, fail } from "kagan/jobs";
import { get, list, rename, sidebar } from "kagan/threads";
import { MAX_WORDS } from "./text.js";
import { decideName, isFinalReason, isKeptTitleError } from "./policy.js";
import {
  ensureDb,
  loadState,
  readLastSweepAt,
  recentNames,
  recordSweep,
  saveState,
} from "./store.js";
import { gatherSignal } from "./signal.js";

/** A failure as one log line, with the stack when the error has one. */
function describe(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * One queued piece of work: a sweep over every thread, or one thread by id.
 * @typedef {{ kind: "sweep", force: boolean, toast?: boolean }
 *   | { kind: "thread", threadId: string }} Work
 */

/** @type {Work[]} */
const queue = [];
let draining = false;
/** Names written and threads skipped by the last sweep in this session. */
/** @type {{ renamed: number, skipped: number } | null} */
let lastRun = null;


export default class Plugin extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      for (;;) {
        let job;
        try {
          job = await next();
        } catch (error) {
          // The host closed the queue: this plugin is unloading.
          log("info", `job loop stopped: ${describe(error)}`);
          return;
        }
        try {
          reply(job.id, await dispatchJob(job));
        } catch (error) {
          fail(job.id, String(error));
        }
      }
    });

    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await ensureDb();
          queue.push({ kind: "sweep", force: false });
        } catch (error) {
          log("error", `sweep timer: ${describe(error)}`);
        }
        await cx.sleep(Math.max(5, cfg().intervalSec) * 1000);
      }
    });

    // Adaptive poll: wake fast when work is queued.
    cx.spawn(async (cx) => {
      for (;;) {
        await drain();
        await cx.sleep(queue.length ? 40 : 600);
      }
    });
  }

  render() {
    return div();
  }
}

export class StatusPanel extends View {
  init(_props, cx) {
    this.rows = [];
    this.enabled = true;
    this.summary = "Starting…";
    this.timer = cx.timer.every(2000, async (cx) => {
      this.enabled = cfg().enabled;
      try {
        this.rows = await recentNames();
        this.summary = await describeLastCheck();
      } catch (error) {
        this.summary = `Cannot read naming state: ${error}`;
      }
      cx.notify();
    });
  }

  render() {
    const lines = this.rows.map((row) =>
      row.reason && row.reason !== "better" ? `${row.title} · ${row.reason}` : row.title,
    );
    const status = this.enabled ? "Renaming is on" : "Renaming is paused";
    return v_flex()
      .gap_1()
      .p_2()
      .children([
        new KgButton("refresh-now")
          .label("Update thread names now")
          .primary()
          .compact()
          .on_click((_e, cx) => {
            queue.push({ kind: "sweep", force: true, toast: true });
            this.summary = "Updating…";
            cx.notify();
          }),
        div().child(status),
        div().child(this.summary),
        div().child("Kagan keeps a title after the first name, so each thread is named once."),
        div().child(lines.length ? lines.join("\n") : "No names yet"),
      ]);
  }
}

async function describeLastCheck() {
  const at = await readLastSweepAt();
  const when = at ? `Last check: ${new Date(at).toLocaleString()}` : "No check yet — press the button";
  if (!lastRun) return when;
  return `${when} · renamed ${lastRun.renamed}, skipped ${lastRun.skipped}`;
}

/**
 * @param {import("kagan/jobs").Job} job
 * @returns {Promise<null>}
 */
async function dispatchJob(job) {
  await ensureDb();

  if (job.kind === "command" && job.command === "refresh") {
    queue.push({ kind: "sweep", force: true, toast: true });
    log("info", "refresh queued");
    return null;
  }

  if (job.kind === "command" && job.command === "where-enabled") {
    await toast("Settings → Auto Name → Rename threads automatically");
    return null;
  }

  if (job.kind === "event") {
    const threadId = typeof job.threadId === "string" ? job.threadId : "";
    if (threadId && cfg().enabled) queue.push({ kind: "thread", threadId });
    return null;
  }

  throw new Error(`Unknown ${job.kind} job${job.kind === "command" ? `: ${job.command}` : ""}`);
}

async function drain() {
  if (draining || queue.length === 0) return;
  draining = true;
  try {
    while (queue.length) {
      const batch = queue.splice(0, queue.length);
      try {
        await runBatch(batch);
      } catch (error) {
        // One bad batch must not lose the rest of the queue.
        log("error", `drain: ${describe(error)}`);
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * @param {Work[]} batch
 */
async function runBatch(batch) {
  const forced = batch.some((w) => w.kind === "sweep" && w.force);
  const toastAfter = batch.some((w) => w.kind === "sweep" && w.toast);
  /** @type {Set<string>} */
  const focus = new Set();
  for (const w of batch) if (w.kind === "thread") focus.add(w.threadId);

  /** @type {Set<string>} */
  const named = new Set();
  /** @type {Set<string>} */
  const seen = new Set();

  if (focus.size && !forced) {
    for (const id of focus) {
      seen.add(id);
      if ((await considerThread(id, { deep: true })) === "named") named.add(id);
    }
    if (await dueForSweep()) {
      const full = await sweepAll({ force: false, skip: seen });
      for (const id of full.named) named.add(id);
      for (const id of full.seen) seen.add(id);
    }
  } else {
    const full = await sweepAll({ force: forced });
    for (const id of full.named) named.add(id);
    for (const id of full.seen) seen.add(id);
  }

  lastRun = { renamed: named.size, skipped: seen.size - named.size };
  if (toastAfter) await toast(`Renamed ${named.size}, skipped ${seen.size - named.size}`);
}

function cfg() {
  const s = settings() || {};
  const interval = Number(s.intervalSec);
  const maxWords = Number(s.maxWords);
  return {
    enabled: s.enabled !== false,
    intervalSec: Number.isFinite(interval) && interval > 0 ? interval : 45,
    maxWords:
      Number.isFinite(maxWords) && maxWords >= 1 && maxWords <= MAX_WORDS
        ? maxWords
        : MAX_WORDS,
  };
}

async function dueForSweep() {
  return Date.now() - (await readLastSweepAt()) >= cfg().intervalSec * 1000;
}

/**
 * A thread the window lists: not hidden and not archived.
 * @param {{ visibility?: string, archivedAt?: number | null }} thread
 */
function isListed(thread) {
  return thread.visibility !== "hidden" && !thread.archivedAt;
}

/**
 * @param {{ force?: boolean, skip?: Set<string> }} [opts]
 * @returns {Promise<{ named: string[], seen: string[] }>}
 */
async function sweepAll(opts = {}) {
  await recordSweep();
  /** @type {string[]} */
  const named = [];
  /** @type {string[]} */
  const seen = [];
  if (!cfg().enabled && !opts.force) return { named, seen };

  for (const thread of await visibleThreads()) {
    if (opts.skip?.has(thread.id)) continue;
    seen.push(thread.id);
    if ((await considerThread(thread.id, { deep: true, force: !!opts.force })) === "named") {
      named.push(thread.id);
    }
  }
  log("info", `sweep (${opts.force ? "force" : "soft"}): named ${named.length}, seen ${seen.length}`);
  return { named, seen };
}

/**
 * @returns {Promise<{ id: string, visibility?: string, archivedAt?: number | null }[]>}
 */
async function visibleThreads() {
  try {
    return (sidebar().threads || []).filter(isListed);
  } catch (error) {
    log("debug", `sidebar: ${describe(error)}`);
    return (await list({ archived: false, limit: 80 })).filter(isListed);
  }
}

/** A failed row write is logged; it must not escape the batch. */
/**
 * @param {{ threadId: string, title: string,
 *   reason: import("./policy.js").NameReason }} name
 */
async function remember(name) {
  try {
    await saveState({ ...name, settled: true });
  } catch (error) {
    log("warn", `save ${name.threadId}: ${describe(error)}`);
  }
}

/**
 * @param {string} threadId
 * @param {{ deep?: boolean, force?: boolean }} [opts]
 * @returns {Promise<"named" | "skipped" | "failed">}
 */
async function considerThread(threadId, opts = {}) {
  if (!threadId) return "skipped";
  const c = cfg();
  if (!c.enabled && !opts.force) return "skipped";

  const state = await loadState(threadId);
  if (state?.settled) return "skipped";

  let thread;
  try {
    thread = await get(threadId);
  } catch (error) {
    log("warn", `get ${threadId}: ${describe(error)}`);
    return "failed";
  }
  if (!isListed(thread)) return "skipped";

  const signal = await gatherSignal(thread, { deep: !!opts.deep });
  const decision = decideName({
    currentTitle: thread.title,
    autoTitle: state?.title,
    goal: signal.goal,
    recent: signal.recent,
    prompt: signal.prompt,
    paths: signal.paths,
    maxWords: c.maxWords,
  });

  if (!decision.title) {
    // Settle it so a finished thread is not re-scored on every sweep.
    if (isFinalReason(decision.reason)) {
      await remember({ threadId, title: thread.title, reason: decision.reason });
    }
    return "skipped";
  }

  try {
    await rename(threadId, decision.title);
  } catch (error) {
    if (isKeptTitleError(error)) {
      await remember({ threadId, title: thread.title, reason: "kept" });
    } else {
      log("warn", `rename ${threadId} → “${decision.title}”: ${describe(error)}`);
      return "failed";
    }
    return "skipped";
  }

  await remember({ threadId, title: decision.title, reason: decision.reason });
  log("info", `named ${threadId}: “${thread.title}” → “${decision.title}” (${decision.reason})`);
  return "named";
}
