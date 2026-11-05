import { test } from "node:test";
import assert from "node:assert/strict";
import { decideName, hasEnoughEvidence, isFinalReason, isKeptTitleError } from "./policy.js";

const goal = [
  "create a kagan plugin that implement auto thread naming",
  "using efficient deterministic techniques",
  "so each thread name in the sidebar periodically refreshes",
  "",
  "Edited auto-name/main.js",
  "Edited auto-name/name.js",
  "Building the rename scorer and wiring events",
];

const said = goal.join("\n");

test("needs five words of prompt or a changed file", () => {
  assert.equal(hasEnoughEvidence("continue"), false);
  assert.equal(hasEnoughEvidence("fix the canvas panel crash"), true);
  assert.equal(hasEnoughEvidence("/ship"), true);
  assert.equal(hasEnoughEvidence("continue", ["canvas/panel.js"]), true);
  // A bare folder or index file is not evidence of anything.
  assert.equal(hasEnoughEvidence("continue", ["src/index.ts"]), false);
});

test("a title changed in the window is kept", () => {
  const r = decideName({ currentTitle: "my own name", autoTitle: "auto name", prompt: said });
  assert.equal(r.title, null);
  assert.equal(r.reason, "kept");
});

test("a real title is kept without asking the host", () => {
  const r = decideName({ currentTitle: "canvas panel crash", prompt: said, goal });
  assert.equal(r.title, null);
  assert.equal(r.reason, "kept");
});

test("a one-word prompt keeps the thread's title", () => {
  const r = decideName({ currentTitle: "agent", prompt: "continue", goal: ["continue"] });
  assert.equal(r.title, null);
  assert.equal(r.reason, "too-short");
});

test("names a placeholder thread from enough evidence", () => {
  const r = decideName({
    currentTitle: "agent",
    prompt: said,
    goal,
    paths: ["auto-name/name.js"],
  });
  assert.ok(r.title);
  assert.equal(r.reason, "better");
});

test("says so when there is no name to propose", () => {
  const r = decideName({ currentTitle: "agent", prompt: said, goal: [] });
  assert.equal(r.title, null);
  assert.equal(r.reason, "no-signal");
});

test("recognises the kept-title error", () => {
  assert.ok(isKeptTitleError(new Error("the title is kept; rename it in the window")));
  assert.ok(!isKeptTitleError(new Error("thread not found")));
});

test("only a kept title ends the search", () => {
  assert.ok(isFinalReason("kept"));
  for (const reason of ["too-short", "no-signal", "better"]) {
    assert.ok(!isFinalReason(reason), `${reason} should not settle`);
  }
});
