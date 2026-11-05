import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The plugin talks to kagan through bare module names. A resolver hook points
// them at fakes in a temp dir so the real main.js can be driven end to end.
const STUBS = {
  "loader.mjs": `
const map = {
  "gpui-kit": "./gpui-kit.mjs",
  "gpui-base": "./gpui-base.mjs",
  "gpui-component": "./gpui-component.mjs",
  "kagan/host": "./kagan-host.mjs",
  "kagan/jobs": "./kagan-jobs.mjs",
  "kagan/threads": "./kagan-threads.mjs",
  "kagan/database": "./kagan-database.mjs",
};
export async function resolve(specifier, context, nextResolve) {
  const target = map[specifier];
  if (target) return { url: new URL(target, import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
`,
  "gpui-kit.mjs": `
const node = () => {
  const n = {};
  for (const call of ["child", "children", "gap_1", "p_2"]) n[call] = () => n;
  return n;
};
export const div = () => node();
export class View {
  init() {}
  render() { return null; }
}
`,
  "gpui-base.mjs": `
const node = () => {
  const n = {};
  for (const call of ["child", "children", "gap_1", "p_2"]) n[call] = () => n;
  return n;
};
export const v_flex = () => node();
`,
  "gpui-component.mjs": `
export class KgButton {
  constructor(id) { this.id = id; }
  label() { return this; }
  primary() { return this; }
  compact() { return this; }
  on_click() { return this; }
}
`,
  "kagan-host.mjs": `
export const state = { settings: {}, logs: [], toasts: [] };
export function log(level, message) { state.logs.push({ level, message }); }
export function settings() { return state.settings; }
export async function toast(message) { state.toasts.push(message); }
`,
  "kagan-jobs.mjs": `
export const state = { pending: [], replied: [], failed: [] };
let waiting = null;
export function next() {
  if (state.pending.length) return Promise.resolve(state.pending.shift());
  return new Promise((resolve) => { waiting = resolve; });
}
export function push(job) {
  if (waiting) { const resolve = waiting; waiting = null; resolve(job); }
  else state.pending.push(job);
}
export function reply(id, value) { state.replied.push({ id, value }); }
export function fail(id, message) { state.failed.push({ id, message }); }
`,
  "kagan-threads.mjs": `
export const state = {
  threads: new Map(),
  files: [],
  events: [],
  renamed: [],
  renameError: null,
  sidebarError: null,
};
export async function get(id) {
  const thread = state.threads.get(id);
  if (!thread) throw new Error("thread not found: " + id);
  return { ...thread };
}
export async function list() { return [...state.threads.values()]; }
export async function rename(id, title) {
  if (state.renameError) throw new Error(state.renameError);
  const thread = state.threads.get(id);
  if (!thread) throw new Error("thread not found: " + id);
  thread.title = title;
  state.renamed.push({ id, title });
  return { ...thread };
}
export function sidebar() {
  if (state.sidebarError) throw new Error(state.sidebarError);
  return { threads: [...state.threads.values()] };
}
export async function changes() { return { files: state.files }; }
export async function events(id, opts) {
  return opts && opts.order === "desc" ? [...state.events].reverse() : [...state.events];
}
export async function environment() { return { branch: null, path: null }; }
export async function project() { return { name: "auto-name" }; }
`,
  "kagan-database.mjs": `
import { DatabaseSync } from "node:sqlite";
export const state = { db: null, applied: 0 };
export async function migrate(statements) {
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
`,
};

const said =
  "create a kagan plugin that implements auto thread naming for the sidebar\n" +
  "score candidate word sets from changed paths and recent events";

/** @type {string} */
let sandbox;
/** @type {Record<string, any>} */
let threads;
/** @type {Record<string, any>} */
let db;
/** @type {Record<string, any>} */
let jobs;
/** @type {Record<string, any>} */
let host;
let stop = () => {};

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "auto-name-test-"));
  for (const [name, source] of Object.entries(STUBS)) {
    await writeFile(join(sandbox, name), source.trim());
  }
  register(pathToFileURL(join(sandbox, "loader.mjs")).href);
  const load = (name) => import(pathToFileURL(join(sandbox, name)).href);
  threads = await load("kagan-threads.mjs");
  db = await load("kagan-database.mjs");
  jobs = await load("kagan-jobs.mjs");
  host = await load("kagan-host.mjs");

  const { default: Plugin } = await import("./main.js");
  let running = true;
  const cx = {
    spawn: (run) => void run(cx),
    // The poll loop's short sleeps really wait; the 15s sweep timer parks,
    // so a test never sees a sweep it did not ask for. A promise that never
    // settles does not hold the event loop open.
    sleep: (ms) =>
      running && ms < 5000
        ? new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)))
        : new Promise(() => {}),
    timer: { every: () => null },
    notify: () => {},
  };
  new Plugin().init({}, cx);
  stop = () => {
    running = false;
  };
});

after(async () => {
  stop();
  await rm(sandbox, { recursive: true, force: true });
});

/** Wait for an in-flight batch, then clear every piece of state a test shares. */
async function reset() {
  await new Promise((resolve) => setTimeout(resolve, 30));
  threads.state.threads.clear();
  threads.state.files = [];
  threads.state.events = [];
  threads.state.renamed.length = 0;
  threads.state.renameError = null;
  threads.state.sidebarError = null;
  if (db.state.db) db.state.db.exec("DELETE FROM names; DELETE FROM meta;");
  jobs.state.replied.length = 0;
  jobs.state.failed.length = 0;
  host.state.settings = { enabled: true, intervalSec: "15", maxWords: "4" };
  host.state.toasts.length = 0;
}

/** The stored naming state for a thread. */
async function named(threadId) {
  return (await db.query("SELECT * FROM names WHERE thread_id = ?", [threadId]))[0];
}

function thread(id, title) {
  return {
    id,
    title,
    projectId: "proj_1",
    environmentId: null,
    visibility: "visible",
    archivedAt: null,
    status: "idle",
  };
}

/** Wait for the plugin to reach a state, rather than for a fixed time. */
async function waitFor(check, what) {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const tick = () => waitFor(() => true, "a turn");

async function event(threadId, id = `job_${Math.random()}`) {
  jobs.push({ id, kind: "event", threadId, type: "thread.idle", projectId: "proj_1" });
  await waitFor(() => jobs.state.replied.some((r) => r.id === id), `job ${id}`);
  // The reply is written before the queued sweep runs.
  await waitFor(() => !jobs.state.pending.length, "the queue to settle");
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("names a placeholder thread from its first prompt", async () => {
  await reset();
  threads.state.threads.set("thr_1", thread("thr_1", "agent"));
  threads.state.files = [{ path: "auto-name/main.js" }];
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];

  await event("thr_1");

  assert.deepEqual(threads.state.renamed, [{ id: "thr_1", title: "auto thread naming" }]);
  assert.equal((await named("thr_1")).settled, 1);
  assert.equal((await named("thr_1")).reason, "better");
});

test("never names the same thread twice", async () => {
  await reset();
  threads.state.threads.set("thr_2", thread("thr_2", "agent"));
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];

  await event("thr_2");
  assert.equal(threads.state.renamed.length, 1);

  threads.state.events = [
    { type: "message", data: { role: "user", text: `${said}\nand then some more canvas work` } },
  ];
  await event("thr_2");
  assert.equal(threads.state.renamed.length, 1, "a settled thread is left alone");
});

test("keeps a title the window already holds", async () => {
  await reset();
  threads.state.threads.set("thr_3", thread("thr_3", "agent"));
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];
  threads.state.renameError = "the title is kept; rename it in the window";

  await event("thr_3");

  assert.equal(threads.state.renamed.length, 0);
  assert.equal((await named("thr_3")).settled, 1);
  assert.equal((await named("thr_3")).reason, "kept");
  assert.equal((await named("thr_3")).auto_title, "agent");
});

test("waits for evidence before naming", async () => {
  await reset();
  threads.state.threads.set("thr_4", thread("thr_4", "claude"));
  threads.state.events = [{ type: "message", data: { role: "user", text: "continue" } }];

  await event("thr_4");
  assert.equal(threads.state.renamed.length, 0, "one word is not evidence");
  assert.equal(await named("thr_4"), undefined, "the thread stays open for a later sweep");

  threads.state.events = [
    { type: "message", data: { role: "user", text: "continue" } },
    { type: "message", data: { role: "user", text: said } },
  ];
  await event("thr_4");
  assert.equal(threads.state.renamed.length, 1);
});

test("leaves a thread with a real name alone", async () => {
  await reset();
  threads.state.threads.set("thr_5", thread("thr_5", "canvas panel crash"));
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];

  await event("thr_5");

  assert.equal(threads.state.renamed.length, 0);
  assert.equal((await named("thr_5")).settled, 1);
});

test("keeps renaming off when the setting is off", async () => {
  await reset();
  host.state.settings = { enabled: false, intervalSec: "15", maxWords: "4" };
  threads.state.threads.set("thr_6", thread("thr_6", "agent"));
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];

  await event("thr_6");

  assert.equal(threads.state.renamed.length, 0);
  assert.equal(await named("thr_6"), undefined);
});

test("skips a hidden or archived thread", async () => {
  await reset();
  const hidden = thread("thr_7", "agent");
  hidden.visibility = "hidden";
  threads.state.threads.set("thr_7", hidden);
  const archived = thread("thr_8", "agent");
  archived.archivedAt = 1;
  threads.state.threads.set("thr_8", archived);
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];

  await event("thr_7");
  await event("thr_8");

  assert.equal(threads.state.renamed.length, 0);
});

test("sweeps every listed thread for the refresh command", async () => {
  await reset();
  threads.state.threads.set("thr_9", thread("thr_9", "agent"));
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];

  jobs.push({ id: "job_refresh", kind: "command", command: "refresh" });
  await waitFor(() => threads.state.renamed.length === 1, "the refresh sweep");

  assert.deepEqual(jobs.state.replied.map((r) => r.id), ["job_refresh"]);
  assert.equal(threads.state.renamed.length, 1);
  assert.equal(host.state.toasts.length, 1);
});

test("falls back to list() when the sidebar is not ready", async () => {
  await reset();
  threads.state.sidebarError = "not in this window";
  threads.state.threads.set("thr_10", thread("thr_10", "agent"));
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];

  jobs.push({ id: "job_refresh_2", kind: "command", command: "refresh" });
  await waitFor(() => threads.state.renamed.length === 1, "the fallback sweep");

  assert.equal(threads.state.renamed.length, 1);
});

test("does not spend a full sweep inside the wait interval", async () => {
  await reset();
  threads.state.threads.set("thr_12", thread("thr_12", "agent"));
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];

  // The first event names its thread and, with no sweep on record, sweeps.
  await event("thr_12");
  await waitFor(() => threads.state.renamed.length === 1, "the first name");

  // A thread that appears inside the interval waits for the next check.
  threads.state.threads.set("thr_13", thread("thr_13", "agent"));
  await event("thr_12");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(threads.state.renamed.length, 1, "no sweep inside the interval");

  // A refresh ignores the interval.
  jobs.push({ id: "job_refresh_3", kind: "command", command: "refresh" });
  await waitFor(() => threads.state.renamed.length === 2, "the forced sweep");
});

test("the panel lists the last names it wrote", async () => {
  await reset();
  threads.state.threads.set("thr_panel", thread("thr_panel", "agent"));
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];
  jobs.push({ id: "job_panel", kind: "command", command: "refresh" });
  await waitFor(() => host.state.toasts.length === 1, "the panel sweep");

  const { StatusPanel } = await import("./main.js");
  const panel = new StatusPanel();
  const cx = { timer: { every: () => null }, notify: () => {} };
  panel.init({}, cx);
  panel.rows = await (await import("./store.js")).recentNames();
  panel.summary = "test";
  assert.ok(panel.render(), "render returns a node");
  assert.equal(panel.rows[0].title, "auto thread naming");
});

test("answers every command the manifest declares", async () => {
  await reset();
  const manifest = JSON.parse(
    await (await import("node:fs/promises")).readFile(new URL("./kagan.json", import.meta.url), "utf8"),
  );
  for (const command of manifest.commands) {
    jobs.push({ id: `job_${command.id}`, kind: "command", command: command.id });
  }
  await waitFor(
    () => jobs.state.replied.length + jobs.state.failed.length >= manifest.commands.length,
    "every command to reply",
  );
  assert.deepEqual(jobs.state.failed, [], "a declared command must not throw");
});

test("reports a job that throws instead of dying", async () => {
  await reset();
  jobs.push({ id: "job_bad", kind: "cli", command: "nope" });
  await waitFor(() => jobs.state.failed.length === 1, "the failure reply");
  assert.match(jobs.state.failed[0].message, /Unknown cli job/);
});

test("keeps going when a thread cannot be read", async () => {
  await reset();
  threads.state.threads.set("thr_ok", thread("thr_ok", "agent"));
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];

  // A job for a thread that is gone must not stop the sweep.
  await event("thr_missing");
  assert.deepEqual(jobs.state.failed, []);

  jobs.push({ id: "job_refresh_4", kind: "command", command: "refresh" });
  await waitFor(() => threads.state.renamed.length === 1, "the sweep after a bad id");
});

test("replies to a disabled event job without doing anything", async () => {
  await reset();
  host.state.settings = { enabled: false, intervalSec: "15", maxWords: "4" };
  threads.state.threads.set("thr_11", thread("thr_11", "agent"));
  threads.state.events = [{ type: "message", data: { role: "user", text: said } }];

  await event("thr_11", "job_quiet");

  assert.deepEqual(jobs.state.replied, [{ id: "job_quiet", value: null }]);
  assert.equal(threads.state.renamed.length, 0);
});
