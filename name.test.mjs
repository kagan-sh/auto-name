import { proposeTitle, isPlaceholder, sameMeaning, formatTitle } from "./name.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

{
  const r = proposeTitle({
    currentTitle: "agent",
    screen: `
create a kagan plugin that implement auto thread naming
using efficient deterministic techniques
so each thread name in the sidebar periodically refreshes

Edited auto-name/main.js
Edited auto-name/name.js
Building the rename scorer and wiring events
`,
    paths: ["auto-name/main.js", "auto-name/name.js", "auto-name/kagan.json"],
  });
  assert(r.title, "expected a title");
  assert(!isPlaceholder(r.title), `title should not be placeholder: ${r.title}`);
  assert(r.title.split(" ").length <= 4, `too long: ${r.title}`);
  console.log("case goal+paths →", r.title, r.score.toFixed(1), r.reason);
}

{
  const r = proposeTitle({
    currentTitle: "auto thread naming",
    screen: `
create a kagan plugin that implement auto thread naming
Still refining auto thread naming heuristics in name.js
`,
    paths: ["auto-name/name.js"],
  });
  assert(
    r.reason === "current-good-enough" || r.reason === "same-meaning" || r.title === null,
    `should keep good title, got ${JSON.stringify(r)}`,
  );
  console.log("case already-good →", r.title, r.reason);
}

{
  const r = proposeTitle({
    currentTitle: "cursor-agent",
    screen: "fix canvas panel crash when resizing the sketch surface",
    paths: ["canvas/panel.js"],
  });
  assert(r.title, "expected canvas-ish title");
  console.log("case canvas fix →", r.title, r.score.toFixed(1));
}

{
  assert(sameMeaning("auto name", "auto-name"), "hyphen/space same");
  assert(sameMeaning("auto-name auto name", "auto name"), "deduped same");
  const flip = proposeTitle({
    currentTitle: "auto name",
    screen: "auto-name/main.js\nauto name plugin",
    paths: ["auto-name/main.js"],
  });
  assert(
    flip.title === null || flip.reason === "same-meaning" || flip.reason === "current-good-enough",
    `no flip-flop, got ${JSON.stringify(flip)}`,
  );
  console.log("case no-flip →", flip.title, flip.reason);
}

{
  assert(formatTitle("auto-name auto name") === "auto name", formatTitle("auto-name auto name"));
}

console.log("ok");
