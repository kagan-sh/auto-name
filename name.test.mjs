import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlaceholder, pathHints, proposeTitle } from "./name.js";

const goal = [
  "create a kagan plugin that implement auto thread naming",
  "using efficient deterministic techniques",
  "so each thread name in the sidebar periodically refreshes",
];
const recent = ["Edited auto-name/main.js", "Edited auto-name/name.js", "Building the rename scorer and wiring events"];

test("names a thread from its goal and changed paths", () => {
  const r = proposeTitle({
    goal,
    recent,
    paths: ["auto-name/main.js", "auto-name/name.js", "auto-name/kagan.json"],
  });
  assert.ok(r.title, "expected a title");
  assert.ok(!isPlaceholder(r.title), `title should not be placeholder: ${r.title}`);
  assert.ok(r.title.split(" ").length <= 4, `too long: ${r.title}`);
});

test("replaces a placeholder name with the work", () => {
  const r = proposeTitle({
    goal: ["fix canvas panel crash when resizing the sketch surface"],
    paths: ["canvas/panel.js"],
  });
  assert.ok(r.title, "expected canvas-ish title");
});

test("scores the same evidence the same way twice", () => {
  const once = proposeTitle({ goal, recent, paths: ["auto-name/main.js"], maxWords: 3 });
  const twice = proposeTitle({ goal, recent, paths: ["auto-name/main.js"], maxWords: 3 });
  assert.deepEqual(once, twice);
  assert.ok(once.title);
});

test("titles the work a slash command is applied to", () => {
  const r = proposeTitle({ goal: ["/ship fix login flow for the mobile app"], paths: [] });
  assert.ok(r.title, "expected a title");
  assert.ok(!r.title.includes("ship"), `command token leaked into ${r.title}`);
});

test("names a bare command after the command", () => {
  assert.equal(proposeTitle({ goal: ["/ship"], paths: [] }).title, "ship");
});

test("has no name without evidence", () => {
  const r = proposeTitle({ goal: ["   ", ""], paths: [] });
  assert.equal(r.title, null);
  assert.equal(r.reason, "no-signal");
});

test("prefers the phrase a changed file points at", () => {
  const r = proposeTitle({
    goal: ["the canvas panel crash", "the settings dialog crash"],
    paths: ["canvas/panel.js"],
  });
  assert.equal(r.title, "canvas panel crash");
});

test("prefers a longer run to a single word", () => {
  const r = proposeTitle({ goal: ["canvas panel crash on resize"], paths: [] });
  assert.equal(r.title, "canvas panel crash resize");
});

test("does not name a thread after one vague word", () => {
  const r = proposeTitle({ goal: ["plugin"], paths: [] });
  assert.equal(r.title, null);
});

test("takes a file name as a hint, not a folder", () => {
  assert.deepEqual(pathHints(["auto-name/main.js"]), ["auto name"]);
  assert.deepEqual(pathHints(["src/index.ts"]), []);
});

test("knows a placeholder from a real name", () => {
  for (const title of ["", "agent", "claude", "new thread", "plugin", "kimi"]) {
    assert.ok(isPlaceholder(title), `${title} should be a placeholder`);
  }
  // Kagan titles a new thread after its program, flags included.
  for (const title of ["claude --resume", "bash", "zsh -l", "codex --full-auto"]) {
    assert.ok(isPlaceholder(title), `${title} should be a placeholder`);
  }
  for (const title of ["canvas panel crash", "auto thread naming"]) {
    assert.ok(!isPlaceholder(title), `${title} should not be a placeholder`);
  }
  assert.ok(isPlaceholder(undefined), "a missing title is a placeholder");
});
