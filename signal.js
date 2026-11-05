// @ts-check
/** Evidence for a title: what was said, what changed, where it runs.
 *
 * Failure contract: every read is best effort. A thread that is not listed in
 * this window answers nothing; the failure is a debug log line, not a throw.
 */
import { log } from "kagan/host";
import { changes, events, environment, project } from "kagan/threads";

/** A folder name that is a generated id, not something to name a thread after. */
const GENERATED_FOLDER = /^(thr_[a-f0-9]+|env_[a-f0-9]+|agent-\d+)$/i;

/**
 * @typedef {{ goal: string[], recent: string[], prompt: string, paths: string[] }} Signal
 */

/**
 * @param {import("kagan/threads").Thread} thread
 * @param {{ deep?: boolean }} [opts]
 * @returns {Promise<Signal>}
 */
export async function gatherSignal(thread, opts = {}) {
  const changed = await readChanges(thread, opts);
  const said = await readSaid(thread, opts);
  const place = opts.deep ? await readLocation(thread) : { goal: [], recent: [] };

  return {
    goal: [...said.goal, ...place.goal],
    recent: [...said.recent, ...place.recent],
    // Only what the person said or answered; paths and tool lines are not a prompt.
    prompt: said.prompt,
    paths: [...new Set([...changed, ...said.paths])].slice(0, 40),
  };
}

/**
 * @param {import("kagan/threads").Thread} thread
 * @param {{ deep?: boolean }} opts
 * @returns {Promise<string[]>}
 */
async function readChanges(thread, opts) {
  /** @type {string[]} */
  const paths = [];
  // Soft sweeps: uncommitted only. Deep sweeps: also the branch.
  const scopes = opts.deep
    ? /** @type {const} */ (["uncommitted", "branch"])
    : /** @type {const} */ (["uncommitted"]);
  for (const scope of scopes) {
    try {
      const ch = await changes(thread.id, scope);
      for (const f of ch.files || []) {
        if (f.path) paths.push(f.path);
        if (f.oldPath) paths.push(f.oldPath);
      }
    } catch (error) {
      // Not listed in this window.
      log("warn", `changes ${thread.id} ${scope}: ${error}`);
    }
  }
  return paths;
}

/**
 * The opening lines are the goal, the rest is the latest state.
 * @param {import("kagan/threads").Thread} thread
 * @param {{ deep?: boolean }} opts
 */
async function readSaid(thread, opts) {
  /** @type {string[]} */
  const goal = [];
  /** @type {string[]} */
  const recent = [];
  /** @type {string[]} */
  const prompt = [];
  /** @type {string[]} */
  const paths = [];
  try {
    // Newest first — cheap slice for latest state; the tail becomes goal-ish leftovers.
    const logEvents = await events(thread.id, { limit: opts.deep ? 48 : 24, order: "desc" });
    for (const ev of logEvents.slice().reverse()) {
      const data = /** @type {Record<string, unknown>} */ (ev.data || {});
      const read = readEvent(ev.type, data);
      if (!read.lines.length) continue;
      prompt.push(...read.prompt);
      paths.push(...read.paths);
      if (goal.length < 10) goal.push(...read.lines);
      else recent.push(...read.lines);
    }
  } catch (error) {
    log("warn", `events ${thread.id}: ${error}`);
  }
  return { goal, recent, prompt: prompt.join("\n"), paths };
}

/**
 * What one event says, and whether it is something the person said.
 * @param {string} type
 * @param {Record<string, unknown>} data
 * @returns {{ lines: string[], prompt: string[], paths: string[] }}
 */
function readEvent(type, data) {
  /** @type {{ lines: string[], prompt: string[], paths: string[] }} */
  const out = { lines: [], prompt: [], paths: [] };
  if (type === "message" && typeof data.text === "string") {
    // A message the plugin or an agent wrote is not the person's prompt.
    const spoken = typeof data.role !== "string" || data.role === "user";
    if (!spoken) return out;
    out.lines.push(data.text);
    out.prompt.push(data.text);
  }
  if (type === "notice" && typeof data.text === "string") out.lines.push(data.text);
  if (type === "answered" && typeof data.title === "string") {
    out.lines.push(...summarizeAnswered(data.title));
    out.prompt.push(data.title);
  }
  if (type === "file.changed" && typeof data.path === "string") {
    out.paths.push(data.path);
    out.lines.push(data.path);
  }
  if (type === "file.predicted") {
    if (typeof data.path === "string") out.paths.push(data.path);
    if (typeof data.line === "string") out.lines.push(data.line);
  }
  if (type === "tool" && typeof data.name === "string") out.lines.push(data.name);
  return out;
}

/**
 * Branch and folder, only on a deep sweep.
 * @param {import("kagan/threads").Thread} thread
 */
async function readLocation(thread) {
  /** @type {string[]} */
  const goal = [];
  /** @type {string[]} */
  const recent = [];
  try {
    if (thread.environmentId) {
      const env = await environment(thread.environmentId);
      if (env.branch && !/^(main|master|develop|trunk)$/i.test(env.branch)) {
        recent.push(env.branch.replace(/[-_/]+/g, " "));
      }
      if (env.path) {
        const folder = env.path.split(/[/\\]/).filter(Boolean).pop() || "";
        if (folder && !GENERATED_FOLDER.test(folder)) recent.push(folder.replace(/[-_]+/g, " "));
      }
    }
  } catch (error) {
    log("warn", `environment ${thread.environmentId}: ${error}`);
  }

  try {
    const proj = await project(String(thread.projectId || ""));
    if (proj?.name && !/^personal$/i.test(proj.name)) goal.push(proj.name);
  } catch (error) {
    log("warn", `project ${thread.projectId}: ${error}`);
  }

  return { goal, recent };
}

/**
 * The useful words of a question the person answered.
 * @param {string} title
 */
function summarizeAnswered(title) {
  const head = String(title || "").split("\n")[0] || "";
  const install = head.match(/^Install\s+(.+?)(?:\s+\d|\s+\(|$)/i);
  if (install) {
    /** @type {string[]} */
    const bits = [install[1].replace(/\s+\d+(\.\d+)*$/, "").trim()];
    const id = head.match(/\((dev\.[^)]+)\)/);
    if (id) bits.push(id[1].split(".").pop() || "");
    return bits.filter(Boolean);
  }
  return head.length >= 8 && head.length < 120 ? [head] : [];
}
