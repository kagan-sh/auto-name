// @ts-check
/** Naming state in the plugin's own SQLite file. No naming rules live here.
 *
 * Failure contract: every call throws. A caller that cannot continue should
 * let it out; a caller that can (the panel) catches and says so.
 */
import { migrate, query, run as dbRun } from "kagan/database";

/** @type {Promise<void> | null} */
let ready = null;

/**
 * Schema, applied once each, in order. Kagan records how many have run, so a
 * statement is never applied twice and a new one only reaches old databases.
 */
export const MIGRATIONS = [
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
  `ALTER TABLE names ADD COLUMN settled INTEGER NOT NULL DEFAULT 0`,
  // 0.4: the evidence fingerprint was never compared to anything, so it goes.
  `CREATE TABLE names_v4 (
    thread_id TEXT PRIMARY KEY,
    auto_title TEXT NOT NULL,
    reason TEXT NOT NULL,
    renamed_at INTEGER NOT NULL,
    settled INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO names_v4 (thread_id, auto_title, reason, renamed_at, settled)
    SELECT thread_id, auto_title, reason, renamed_at, settled FROM names;
  DROP TABLE names;
  ALTER TABLE names_v4 RENAME TO names`,
];

/**
 * A failed migration is retried on the next call instead of failing for good.
 * @returns {Promise<void>}
 */
export async function ensureDb() {
  if (!ready) {
    ready = migrate(MIGRATIONS).catch((error) => {
      ready = null;
      throw error;
    });
  }
  await ready;
}

/**
 * @typedef {{ thread_id: string, auto_title: string, reason: string,
 *   renamed_at: number, settled: number }} NameRow
 */

/**
 * @param {string} threadId
 * @returns {Promise<{ title: string, reason: import("./policy.js").NameReason,
 *   settled: boolean } | null>}
 */
export async function loadState(threadId) {
  await ensureDb();
  const rows = /** @type {NameRow[]} */ (
    await query(
      "SELECT thread_id, auto_title, reason, renamed_at, settled FROM names WHERE thread_id = ?",
      [threadId],
    )
  );
  const row = rows[0];
  if (!row) return null;
  // The column holds a reason this plugin wrote, so the cast is the boundary.
  const reason = /** @type {import("./policy.js").NameReason} */ (row.reason);
  return { title: row.auto_title, reason, settled: Boolean(row.settled) };
}

/**
 * @param {{ threadId: string, title: string,
 *   reason: import("./policy.js").NameReason, settled: boolean }} name
 */
export async function saveState({ threadId, title, reason, settled }) {
  await ensureDb();
  await dbRun(
    `INSERT INTO names (thread_id, auto_title, reason, renamed_at, settled)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       auto_title = excluded.auto_title,
       reason = excluded.reason,
       renamed_at = excluded.renamed_at,
       settled = excluded.settled`,
    [threadId, title, reason, Date.now(), settled ? 1 : 0],
  );
}

/**
 * The last names written, newest first, for the panel.
 * @returns {Promise<{ title: string, reason: import("./policy.js").NameReason }[]>}
 */
export async function recentNames() {
  await ensureDb();
  const rows = /** @type {{ auto_title: string, reason: string }[]} */ (
    await query(
      "SELECT auto_title, reason FROM names ORDER BY renamed_at DESC, thread_id DESC LIMIT 8",
      [],
    )
  );
  return rows.map((row) => ({
    title: row.auto_title,
    reason: /** @type {import("./policy.js").NameReason} */ (row.reason),
  }));
}

/**
 * When the last full sweep started.
 * @returns {Promise<number>}
 */
export async function readLastSweepAt() {
  await ensureDb();
  const rows = await query("SELECT value FROM meta WHERE key = ?", ["last_sweep_at"]);
  const at = Number(rows[0]?.value || 0);
  return Number.isFinite(at) ? at : 0;
}

export async function recordSweep() {
  await ensureDb();
  await dbRun(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ["last_sweep_at", String(Date.now())],
  );
}
