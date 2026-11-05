import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("./kagan.json", import.meta.url), "utf8"));
const source = await readFile(new URL("./main.js", import.meta.url), "utf8");

test("the manifest points at the plugin entry", () => {
  assert.equal(manifest.entry, "main.js");
});

test("the word ceiling matches the manifest", async () => {
  const { MAX_WORDS } = await import("./text.js");
  const options = manifest.settings.maxWords.options;
  assert.equal(options[options.length - 1], String(MAX_WORDS));
});

test("every declared setting is read, and nothing else is", () => {
  for (const key of Object.keys(manifest.settings)) {
    assert.ok(source.includes(`s.${key}`), `setting ${key} is declared but never read`);
  }
  for (const [, key] of source.matchAll(/\bs\.([A-Za-z]\w*)/g)) {
    assert.ok(key in manifest.settings, `main.js reads undeclared setting ${key}`);
  }
});

test("the plugin asks only for the areas it uses", () => {
  assert.deepEqual(manifest.powers.areas, ["threads", "database"]);
});
