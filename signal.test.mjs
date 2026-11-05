import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// signal.js reads a thread through kagan. These fakes answer the four calls.
const THREADS_STUB = `
export const state = { files: [], events: [], branch: null, path: null, project: "auto-name", failReads: false };
const fail = () => { if (state.failReads) throw new Error("host is down"); };
export async function changes() { fail(); return { files: state.files }; }
export async function events(id, opts) {
  fail();
  return opts && opts.order === "desc" ? [...state.events].reverse() : [...state.events];
}
export async function environment() { fail(); return { branch: state.branch, path: state.path }; }
export async function project() { fail(); return { name: state.project }; }
`;

const HOST_STUB = `
export const state = { logs: [] };
export function log(level, message) { state.logs.push({ level, message }); }
`;

const LOADER = `
const map = {
  "kagan/host": "./kagan-host.mjs",
  "kagan/threads": "./kagan-threads.mjs",
};
export async function resolve(specifier, context, nextResolve) {
  const target = map[specifier];
  if (target) return { url: new URL(target, import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;

/** @type {string} */
let sandbox;
/** @type {Record<string, any>} */
let signal;
/** @type {Record<string, any>} */
let threads;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "auto-name-signal-"));
  await writeFile(join(sandbox, "loader.mjs"), LOADER.trim());
  await writeFile(join(sandbox, "kagan-threads.mjs"), THREADS_STUB.trim());
  await writeFile(join(sandbox, "kagan-host.mjs"), HOST_STUB.trim());
  register(pathToFileURL(join(sandbox, "loader.mjs")).href);
  threads = await import(pathToFileURL(join(sandbox, "kagan-threads.mjs")).href);
  signal = await import("./signal.js");
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

const thread = {
  id: "thr_1",
  projectId: "proj_1",
  environmentId: "env_1",
  title: "agent",
  visibility: "visible",
};

function reset() {
  threads.state.files = [];
  threads.state.events = [];
  threads.state.branch = null;
  threads.state.path = null;
  threads.state.project = "auto-name";
  threads.state.failReads = false;
}

test("keeps only what was said out of the evidence", async () => {
  reset();
  threads.state.events = [
    { type: "message", data: { role: "user", text: "fix the canvas panel crash" } },
    { type: "tool", data: { name: "bash" } },
    { type: "file.changed", data: { path: "canvas/panel.js" } },
    { type: "notice", data: { severity: "info", text: "rebuilding the panel" } },
  ];

  const got = await signal.gatherSignal(thread);

  assert.equal(got.prompt, "fix the canvas panel crash");
  assert.ok(got.goal.includes("fix the canvas panel crash"));
  assert.ok(got.goal.includes("rebuilding the panel"), "a notice is evidence, not a prompt");
  assert.deepEqual(got.paths, ["canvas/panel.js"]);
});

test("does not take an agent's message for the person's prompt", async () => {
  reset();
  threads.state.events = [
    { type: "message", data: { role: "assistant", text: "I will look at the canvas panel" } },
    { type: "message", data: { role: "user", text: "fix the canvas panel crash" } },
  ];

  const got = await signal.gatherSignal(thread);

  assert.equal(got.prompt, "fix the canvas panel crash");
  assert.ok(!got.goal.includes("I will look at the canvas panel"));
});

test("does not repeat a path it saw twice", async () => {
  reset();
  threads.state.files = [
    { path: "canvas/panel.js" },
    { path: "canvas/panel.js", oldPath: "canvas/old.js" },
  ];
  threads.state.events = [{ type: "file.changed", data: { path: "canvas/panel.js" } }];

  const got = await signal.gatherSignal(thread);

  assert.deepEqual(got.paths, ["canvas/panel.js", "canvas/old.js"]);
});

test("reads the branch and folder only on a deep sweep", async () => {
  reset();
  threads.state.branch = "feat/canvas-panel-crash";
  threads.state.path = "/Users/someone/projects/auto-name";

  const soft = await signal.gatherSignal(thread);
  assert.ok(!soft.recent.join("\n").includes("canvas panel crash"));

  const deep = await signal.gatherSignal(thread, { deep: true });
  const lines = deep.recent.join("\n");
  assert.ok(lines.includes("feat canvas panel crash"));
  assert.ok(lines.includes("auto name"));
});

test("leaves a trunk branch and a generated folder out", async () => {
  reset();
  threads.state.branch = "main";
  threads.state.path = "/Users/someone/.kagan/worktrees/thr_ab12cd34";

  const deep = await signal.gatherSignal(thread, { deep: true });

  const lines = deep.recent.join("\n");
  assert.ok(!lines.includes("main"));
  assert.ok(!lines.includes("thr"));
});

test("reads a question's answer as evidence", async () => {
  reset();
  threads.state.events = [
    { type: "answered", data: { title: "Install auto-name 0.3.0 (dev.kagan.auto-name)", option: "yes" } },
  ];

  const got = await signal.gatherSignal(thread);

  // The answer is the person's words as written, and its useful words are evidence.
  assert.equal(got.prompt, "Install auto-name 0.3.0 (dev.kagan.auto-name)");
  assert.ok(got.goal.join("\n").includes("auto-name"), got.goal.join("\n"));
});

test("answers nothing when the host reads fail", async () => {
  reset();
  threads.state.failReads = true;
  const got = await signal.gatherSignal(thread, { deep: true });
  assert.deepEqual(got, { goal: [], recent: [], prompt: "", paths: [] });
  threads.state.failReads = false;
});

test("keeps the project name out of the evidence when it is Personal", async () => {
  reset();
  threads.state.project = "Personal";

  const deep = await signal.gatherSignal(thread, { deep: true });

  assert.ok(!deep.goal.join("\n").includes("Personal"));
});
