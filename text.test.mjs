import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanText,
  contentRuns,
  formatTitle,
  isUsefulLine,
  isKeptWord,
  splitCommands,
  stem,
  tokens,
} from "./text.js";

test("strips ANSI escapes and collapses blank runs", () => {
  assert.equal(cleanText("\u001b[31mred\u001b[0m  text\r\n\r\n\r\n\r\nnext"), "red text\n\nnext");
});

test("keeps content lines and drops tool noise and blanks", () => {
  assert.ok(isUsefulLine("fix the canvas panel crash"));
  assert.ok(!isUsefulLine("Read main.js"));
  assert.ok(!isUsefulLine(""), "the empty sentinel between evidence zones is not a line");
  assert.ok(!isUsefulLine("short"));
});

test("turns a phrase into a lowercase word set", () => {
  assert.equal(formatTitle("Auto-Name Plugin"), "auto name plugin");
});

test("dedupes repeated words in a name", () => {
  assert.equal(formatTitle("auto-name auto name"), "auto name");
});

test("never cuts a word at the length limit", () => {
  const title = formatTitle("extraordinarily comprehensive documentational");
  assert.equal(title, "extraordinarily comprehensive");
  for (const word of title.split(" ")) {
    assert.ok("extraordinarily comprehensive documentational".includes(word), `cut word: ${word}`);
  }
  // A single word longer than the limit is the only case that is cut.
  assert.equal(formatTitle("x".repeat(50)).length, 36);
});

test("caps a name at four words", () => {
  assert.equal(formatTitle("alpha bravo charlie delta echo"), "alpha bravo charlie delta");
});

test("keeps known compounds whole", () => {
  assert.equal(formatTitle("an end-to-end flow"), "an end-to-end flow");
  assert.deepEqual(tokens("install the in-app plugin"), ["in-app", "plugin"]);
});

test("pulls a leading slash command out of a prompt", () => {
  assert.deepEqual(splitCommands("/ship fix the login flow"), {
    body: " fix the login flow",
    commands: ["ship"],
  });
});

test("collects several commands on one line once", () => {
  assert.deepEqual(splitCommands("/ship /ship /review the thing").commands, ["ship", "review"]);
});

test("leaves a path that looks like a command alone", () => {
  assert.deepEqual(splitCommands("src/name.js is fine").commands, []);
});

test("strips endings so variants of a word share one key", () => {
  assert.equal(stem("naming"), stem("named"));
  assert.equal(stem("changes"), stem("changed"));
  assert.equal(stem("in-app"), "inapp");
  // Short words are left alone; the rule only has to be stable.
  assert.equal(stem("cat"), "cat");
  assert.equal(stem("canvas"), stem("canvas"));
});

test("rejects words a person cannot recall a thread by", () => {
  for (const word of ["the", "123", "thr_ab12", "env_ff00", "dev.kagan", "a", "thr"]) {
    assert.ok(!isKeptWord(word), `${word} should not be kept`);
  }
  assert.ok(isKeptWord("canvas"));
});

test("breaks runs at stop words and ids", () => {
  assert.deepEqual(contentRuns("fix the canvas panel crash for thr_ab12cd34"), [
    ["canvas", "panel", "crash"],
  ]);
});

test("never joins two lines into one run", () => {
  assert.deepEqual(contentRuns("the canvas panel crash\nthe settings dialog crash"), [
    ["canvas", "panel", "crash"],
    ["settings", "dialog", "crash"],
  ]);
});
