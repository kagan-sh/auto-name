// @ts-check
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { KgButton } from "gpui-component";
import { log, settings, toast } from "kagan/host";
import { next, reply, fail } from "kagan/jobs";
import {
  get,
  list,
  rename,
  metadata,
  setMetadata,
  sidebar,
  changes,
  events,
  environment,
  project,
} from "kagan/threads";
import { migrate, query, run as dbRun } from "kagan/database";
import { proposeTitle, isPlaceholder, formatTitle, sameMeaning } from "./name.js";

/** @typedef {{ force: boolean, threadId?: string, toast?: boolean }} Work */

/** @type {Work[]} */
const queue = [];
/** @type {Promise<void> | null} */
let ready = null;
let waking = false;
/** @type {{ at: number, renamed: number, skipped: number } | null} */
let lastSweep = null;

export default class Plugin extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      for (;;) {
        const job = await next();
        try {
          reply(job.id, await handle(job));
        } catch (error) {
          fail(job.id, String(error));
        }
      }
    });

    cx.spawn(async (cx) => {
      await ensureDb();
      enqueue({ force: false });
      for (;;) {
        await cx.sleep(Math.max(5, cfg().intervalSec) * 1000);
        if (cfg().enabled) enqueue({ force: false });
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
}

export class StatusPanel extends View {
  init(_props, cx) {
    this.rows = [];
    this.enabled = true;
    this.summary = "Starting…";
    this.timer = cx.timer.every(2000, async (cx) => {
      await ensureDb();
      this.rows = await query(
        "SELECT auto_title, reason, renamed_at FROM names ORDER BY renamed_at DESC LIMIT 8",
        [],
      );
      this.enabled = cfg().enabled;
      this.summary = lastSweep
        ? `Last update: renamed ${lastSweep.renamed}, skipped ${lastSweep.skipped}`
        : "No update yet — press the button";
      cx.notify();
    });
  }

  render() {
    const lines = this.rows.map((row) => {
      const title = String(row.auto_title || "");
      const why = String(row.reason || "");
      return why && why !== "better" ? `${title} · ${why}` : title;
    });
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
            enqueue({ force: true, toast: true });
            this.summary = "Updating…";
            cx.notify();
          }),
        div().child(status),
        div().child(this.summary),
        div().child(lines.length ? lines.join("\n") : "No renames yet"),
      ]);
  }
}

/**
 * @param {import("kagan/jobs").Job} job
 */
async function handle(job) {
  await ensureDb();

  if (job.kind === "command" && job.command === "refresh") {
    enqueue({ force: true, toast: true });
    log("info", "refresh queued");
    return null;
  }

  if (job.kind === "command" && job.command === "where-enabled") {
    await toast("Settings → Auto Name → Rename threads automatically");
    return null;
  }

  if (job.kind === "event") {
    if (!cfg().enabled) return;
    enqueue({ force: false, threadId: /** @type {string} */ (job.threadId) });
    return;
  }

  throw new Error(`Unknown job ${job.kind}: ${job.command ?? job.type ?? ""}`);
}

/** @param {Work} work */
function enqueue(work) {
  queue.push(work);
}

async function drain() {
  if (waking || queue.length === 0) return;
  waking = true;
  try {
    while (queue.length) {
      const batch = queue.splice(0, queue.length);
      const force = batch.some((w) => w.force);
      const toastAfter = batch.some((w) => w.toast);
      /** @type {Set<string>} */
      const focus = new Set();
      for (const w of batch) if (w.threadId) focus.add(w.threadId);

      let renamed = 0;
      let skipped = 0;

      if (focus.size && !force) {
        for (const id of focus) {
          if (await considerThread(id, { force: false })) renamed++;
          else skipped++;
        }
        if (await dueForSweep()) {
          const full = await sweepAll({ force: false });
          renamed += full.renamed;
          skipped += full.skipped;
        }
      } else {
        const full = await sweepAll({ force });
        renamed = full.renamed;
        skipped = full.skipped;
      }

      lastSweep = { at: Date.now(), renamed, skipped };
      if (toastAfter) await toast(`Renamed ${renamed}, skipped ${skipped}`);
    }
  } catch (error) {
    log("error", `drain: ${error}`);
  } finally {
    waking = false;
  }
}

function cfg() {
  const s = settings() || {};
  const interval = Number(s.intervalSec);
  const maxWords = Number(s.maxWords);
  return {
    enabled: s.enabled !== false,
    respectManual: s.respectManual !== false,
    intervalSec: Number.isFinite(interval) && interval > 0 ? interval : 45,
    maxWords: Number.isFinite(maxWords) && maxWords >= 1 && maxWords <= 4 ? maxWords : 4,
  };
}

async function ensureDb() {
  if (!ready) {
    ready = migrate([
      `CREATE TABLE IF NOT EXISTS names (
        thread_id TEXT PRIMARY KEY,
        auto_title TEXT NOT NULL,
        content_fp TEXT NOT NULL,
        reason TEXT NOT NULL,
        renamed_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    ]).then(() => undefined);
  }
  await ready;
}

async function dueForSweep() {
  const rows = await query("SELECT value FROM meta WHERE key = ?", ["last_sweep_at"]);
  const last = Number(rows[0]?.value || 0);
  return Date.now() - last >= cfg().intervalSec * 1000;
}

/**
 * @param {{ force?: boolean }} [opts]
 */
async function sweepAll(opts = {}) {
  await dbRun(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ["last_sweep_at", String(Date.now())],
  );
  let renamed = 0;
  let skipped = 0;
  if (!cfg().enabled && !opts.force) return { renamed, skipped };

  const threads = await visibleThreads();
  for (const thread of threads) {
    if (await considerThread(thread.id, opts)) renamed++;
    else skipped++;
  }
  log("info", `sweep (${opts.force ? "force" : "soft"}): renamed ${renamed}, skipped ${skipped}`);
  return { renamed, skipped };
}

async function visibleThreads() {
  try {
    const side = sidebar();
    return (side.threads || []).filter((t) => t.visibility !== "hidden" && !t.archivedAt);
  } catch {
    const all = await list({ archived: false, limit: 80 });
    return all.filter((t) => t.visibility !== "hidden");
  }
}

/**
 * @param {string} threadId
 * @param {{ force?: boolean }} [opts]
 */
async function considerThread(threadId, opts = {}) {
  if (!threadId) return false;
  const c = cfg();
  if (!c.enabled && !opts.force) return false;

  let thread;
  try {
    thread = await get(threadId);
  } catch (error) {
    log("warn", `get ${threadId}: ${error}`);
    return false;
  }
  if (thread.archivedAt || thread.visibility === "hidden") return false;

  const state = await loadState(threadId);
  const meta = /** @type {{ autoTitle?: string, hold?: boolean } | null} */ (
    (await metadata(threadId).catch(() => null)) || null
  );

  if (
    c.respectManual &&
    state?.auto_title &&
    thread.title !== state.auto_title &&
    !isPlaceholder(thread.title)
  ) {
    if (!meta?.hold) {
      await setMetadata(threadId, { ...(meta || {}), hold: true, autoTitle: state.auto_title });
      log("info", `hold ${threadId}: manual title “${thread.title}”`);
    }
    // Refresh does not override a name the person set.
    return false;
  }
  if (meta?.hold) return false;

  const signal = await gatherSignal(thread, { deep: !!opts.force });
  const screen = [signal.screen, thread.title].filter(Boolean).join("\n");
  if (!screen && signal.paths.length === 0) return false;

  const proposal = proposeTitle({
    screen,
    paths: signal.paths,
    currentTitle: thread.title,
    maxWords: c.maxWords,
  });

  if (!proposal.title) return false;
  if (sameMeaning(thread.title, proposal.title)) {
    await saveState(threadId, formatTitle(thread.title) || thread.title, proposal.fingerprint, "same-meaning");
    return false;
  }
  if (state?.content_fp === proposal.fingerprint && state?.auto_title && sameMeaning(state.auto_title, proposal.title)) {
    return false;
  }
  if (formatTitle(thread.title) === proposal.title) {
    await saveState(threadId, proposal.title, proposal.fingerprint, "already");
    return false;
  }

  if (!opts.force && state?.renamed_at && Date.now() - Number(state.renamed_at) < c.intervalSec * 1000) {
    return false;
  }

  try {
    await rename(threadId, proposal.title);
  } catch (error) {
    log("warn", `rename ${threadId} → “${proposal.title}”: ${error}`);
    return false;
  }

  await saveState(threadId, proposal.title, proposal.fingerprint, proposal.reason);
  await setMetadata(threadId, {
    ...(meta || {}),
    autoTitle: proposal.title,
    hold: false,
    fp: proposal.fingerprint,
  });
  log(
    "info",
    `named ${threadId}: “${thread.title}” → “${proposal.title}” (${proposal.reason}, ${proposal.score.toFixed(1)})`,
  );
  return true;
}

/**
 * @param {import("kagan/threads").Thread} thread
 * @param {{ deep?: boolean }} [opts]
 */
async function gatherSignal(thread, opts = {}) {
  /** @type {string[]} */
  const paths = [];
  /** @type {string[]} */
  const goalLines = [];
  /** @type {string[]} */
  const recentLines = [];

  // Soft sweeps: uncommitted only. Force: also branch (one extra host call).
  const scopes = opts.deep
    ? /** @type {const} */ (["uncommitted", "branch"])
    : /** @type {const} */ (["uncommitted"]);
  for (const scope of scopes) {
    try {
      const ch = await changes(thread.id, scope);
      for (const f of ch.files || []) {
        if (f.path) paths.push(f.path);
        if (f.oldPath) paths.push(f.oldPath);
      }
    } catch {
      // Not listed in this window.
    }
  }

  try {
    // Newest first — cheap slice for latest state; tail of array becomes goal-ish leftovers.
    const logEvents = await events(thread.id, { limit: opts.deep ? 48 : 24, order: "desc" });
    const chronological = logEvents.slice().reverse();
    for (const ev of chronological) {
      const data = /** @type {Record<string, unknown>} */ (ev.data || {});
      /** @type {string[]} */
      const bits = [];
      if (ev.type === "message" && typeof data.text === "string") bits.push(data.text);
      if (ev.type === "notice" && typeof data.text === "string") bits.push(data.text);
      if (ev.type === "answered" && typeof data.title === "string") bits.push(...summarizeAnswered(data.title));
      if (ev.type === "file.changed" && typeof data.path === "string") {
        paths.push(data.path);
        bits.push(data.path);
      }
      if (ev.type === "file.predicted") {
        if (typeof data.path === "string") paths.push(data.path);
        if (typeof data.line === "string") bits.push(data.line);
      }
      if (ev.type === "tool" && typeof data.name === "string") bits.push(data.name);
      if (!bits.length) continue;
      if (goalLines.length < 10) goalLines.push(...bits);
      else recentLines.push(...bits);
    }
  } catch (error) {
    log("debug", `events ${thread.id}: ${error}`);
  }

  if (opts.deep) {
    try {
      if (thread.environmentId) {
        const env = await environment(thread.environmentId);
        if (env.branch && !/^(main|master|develop|trunk)$/i.test(env.branch)) {
          recentLines.push(env.branch.replace(/[-_/]+/g, " "));
        }
        if (env.path) {
          const base = env.path.split(/[/\\]/).filter(Boolean).pop();
          if (base && !/^(personal|agent|agent-\d+|env_[a-f0-9]+)$/i.test(base)) {
            recentLines.push(base.replace(/[-_]+/g, " "));
          }
        }
      }
    } catch {
      // ignore
    }

    try {
      const proj = await project(thread.projectId);
      if (proj?.name && !/^(personal)$/i.test(proj.name)) goalLines.push(proj.name);
    } catch {
      // ignore
    }
  }

  for (const p of paths.slice(0, 12)) goalLines.push(p);

  return {
    screen: [...goalLines, "", ...recentLines].join("\n"),
    paths: [...new Set(paths)].slice(0, 40),
  };
}

/**
 * @param {string} threadId
 */
async function loadState(threadId) {
  const rows = await query(
    "SELECT thread_id, auto_title, content_fp, reason, renamed_at FROM names WHERE thread_id = ?",
    [threadId],
  );
  return rows[0] || null;
}

/**
 * @param {string} threadId
 * @param {string} title
 * @param {string} fp
 * @param {string} reason
 */
async function saveState(threadId, title, fp, reason) {
  await dbRun(
    `INSERT INTO names (thread_id, auto_title, content_fp, reason, renamed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       auto_title = excluded.auto_title,
       content_fp = excluded.content_fp,
       reason = excluded.reason,
       renamed_at = excluded.renamed_at`,
    [threadId, title, fp, reason, Date.now()],
  );
}

/**
 * @param {string} title
 */
function summarizeAnswered(title) {
  const head = String(title || "").split("\n")[0] || "";
  /** @type {string[]} */
  const bits = [];
  const install = head.match(/^Install\s+(.+?)(?:\s+\d|\s+\(|$)/i);
  if (install) {
    bits.push(install[1].replace(/\s+\d+(\.\d+)*$/, "").trim());
    const id = head.match(/\((dev\.[^)]+)\)/);
    if (id) bits.push(id[1].split(".").pop() || "");
    return bits.filter(Boolean);
  }
  if (/caution:|clipboard|database|powers/i.test(title)) {
    return head.length > 8 && head.length < 80 ? [head] : bits;
  }
  if (head.length >= 8 && head.length < 120) bits.push(head);
  return bits;
}
