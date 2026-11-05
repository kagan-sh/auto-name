import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// This file owns its store.js instance, so the migration has not run yet.
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
  export async function query(sql, params) { return state.db.prepare(sql).all(...params); }
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
  sandbox = await mkdtemp(join(tmpdir(), "auto-name-retry-"));
  await writeFile(join(sandbox, "loader.mjs"), LOADER.trim());
  await writeFile(join(sandbox, "kagan-database.mjs"), DATABASE_STUB.trim());
  register(pathToFileURL(join(sandbox, "loader.mjs")).href);
  database = await import(pathToFileURL(join(sandbox, "kagan-database.mjs")).href);
  store = await import("./store.js");
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

test("retries a migration that failed instead of failing for good", async () => {
  database.state.failMigrate = true;
  await assert.rejects(store.ensureDb(), /disk full/);
  database.state.failMigrate = false;

  // The next call migrates again instead of replaying the old failure.
  assert.equal(await store.loadState("thr_none"), null);
});
