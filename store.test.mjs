import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// store.js asks kagan for a database. This adapter is the same three calls
// over a real SQLite database, so the schema and the SQL are what is tested.
const DATABASE_STUB = `
import { DatabaseSync } from "node:sqlite";
export const state = { db: null, applied: 0, failMigrate: false };
export async function migrate(statements) {
  if (state.failMigrate) throw new Error("disk full");
  if (!state.db) state.db = new DatabaseSync(":memory:");
  for (const sql of statements.slice(state.applied)) {
    state.db.exec(sql);
    state.applied += 1;
  }
}
export async function query(sql, params) {
  return state.db.prepare(sql).all(...params);
}
export async function run(sql, params) {
  const result = state.db.prepare(sql).run(...params);
  return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
}
`;

const LOADER = `
const map = { "kagan/database": "./kagan-database.mjs" };
export async function resolve(specifier, context, nextResolve) {
  const target = map[specifier];
  if (target) return { url: new URL(target, import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;

/** @type {string} */
let sandbox;
/** @type {Record<string, any>} */
let store;
/** @type {Record<string, any>} */
let database;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "auto-name-store-"));
  await writeFile(join(sandbox, "loader.mjs"), LOADER.trim());
  await writeFile(join(sandbox, "kagan-database.mjs"), DATABASE_STUB.trim());
  register(pathToFileURL(join(sandbox, "loader.mjs")).href);
  database = await import(pathToFileURL(join(sandbox, "kagan-database.mjs")).href);
  store = await import("./store.js");
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/** A database at the shape an older version of this plugin wrote. */
function oldDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(store.MIGRATIONS[0]);
  db.exec(store.MIGRATIONS[1]);
  db.exec("INSERT INTO names VALUES ('thr_old', 'old name', 'fp', 'better', 1)");
  return db;
}

test("remembers a name and settles the thread", async () => {
  assert.equal(await store.loadState("thr_1"), null);

  await store.saveState({ threadId: "thr_1", title: "auto thread naming", reason: "better", settled: true });

  const row = await store.loadState("thr_1");
  assert.equal(row.title, "auto thread naming");
  assert.equal(row.reason, "better");
  assert.equal(row.settled, true);
});

test("writes one row per thread", async () => {
  await store.saveState({ threadId: "thr_1", title: "auto naming", reason: "kept", settled: false });

  const rows = await database.query("SELECT * FROM names WHERE thread_id = ?", ["thr_1"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].auto_title, "auto naming");
  assert.equal(rows[0].settled, 0);
  assert.equal((await store.loadState("thr_1")).settled, false);
});

test("upgrades a 0.2 database and drops the unused fingerprint", () => {
  const old = oldDatabase();

  for (const sql of store.MIGRATIONS.slice(2)) old.exec(sql);

  const columns = old.prepare("PRAGMA table_info(names)").all().map((c) => c.name);
  assert.deepEqual(columns, ["thread_id", "auto_title", "reason", "renamed_at", "settled"]);
  const row = old.prepare("SELECT * FROM names WHERE thread_id = ?").get("thr_old");
  assert.equal(row.auto_title, "old name");
  assert.equal(row.settled, 0, "an existing name is not settled by the migration");
  old.close();
});

test("lists the newest names first, with its own rows", async () => {
  await database.query("DELETE FROM names", []);
  await store.saveState({ threadId: "thr_2", title: "second name", reason: "better", settled: true });
  await store.saveState({ threadId: "thr_3", title: "third name", reason: "better", settled: true });

  const rows = await store.recentNames();
  assert.deepEqual(
    rows.map((row) => row.title),
    ["third name", "second name"],
  );
});

test("remembers when the last sweep ran", async () => {
  await database.query("DELETE FROM meta", []);
  assert.equal(await store.readLastSweepAt(), 0);

  await store.recordSweep();

  assert.ok((await store.readLastSweepAt()) > 0);
});
