// Each immutable revision has a parent. Offline edits to the same parent
// create two resumable heads, so syncing never overwrites either answer.
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const digest = value => createHash("sha256").update(value).digest("hex");
const locks = new Map();

export async function exclusive(key, work) {
  const previous = locks.get(key) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(work);
  locks.set(key, job);
  try { return await job; }
  finally { if (locks.get(key) === job) locks.delete(key); }
}

export async function jsonFile(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("伴学记录无法读取，已保留原文件。", { cause: error });
  }
}

export async function writeJson(path, value) {
  const tmp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}

export async function readJournal(dir) {
  const names = (await readdir(dir)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  const events = new Map();
  const parents = new Set();
  for (const name of names) {
    const event = await jsonFile(join(dir, name));
    const id = name.slice(0, -5);
    if (!event || event.format !== 1 || digest(JSON.stringify(event)) !== id)
      throw new Error("课程记忆未完整写入或同步，请重试。");
    events.set(id, event);
    if (event.parent) parents.add(event.parent);
  }
  for (const id of parents) {
    if (!events.has(id)) throw new Error("课程记忆仍在同步，稍后重试。");
  }
  return { events, heads: [...events.keys()].filter(id => !parents.has(id)).sort() };
}

export function lineage(events, id) {
  const chain = [];
  while (id) {
    chain.push(id);
    id = events.get(id).parent;
  }
  return chain.reverse();
}

export function restore(events, id) {
  const state = { sources: {}, attempts: [] };
  for (const key of lineage(events, id)) {
    const { fields, sources, attempts } = events.get(key);
    Object.assign(state, fields);
    Object.assign(state.sources, sources);
    for (const item of attempts) state.attempts.push(item);
  }
  return state;
}

export async function record(dir, parent, before, state) {
  const { sources, attempts, ...fields } = state;
  for (const key of Object.keys(fields)) {
    if (JSON.stringify(before?.[key]) === JSON.stringify(fields[key])) delete fields[key];
  }
  const event = {
    format: 1, parent, fields,
    sources: Object.fromEntries(Object.entries(sources).filter(([id]) => !Object.hasOwn(before?.sources ?? {}, id))),
    attempts: attempts.slice(before?.attempts.length ?? 0),
  };
  const id = digest(JSON.stringify(event));
  await writeJson(join(dir, id + ".json"), event);
  return id;
}

export function brief(s) {
  const last = s.attempts.at(-1);
  const unit = s.units[s.index]?.title ?? (s.stage === "finished" ? "结束" : "迁移复测");
  const result = last && {
    topic: s.units[last.unit]?.title ?? "迁移复测",
    outcome: last.correct ? "答对过" : "最近答错，待复测",
    source: s.sources[last.source]?.label,
  };
  return { goal: s.goal, unit: s.units.length ? unit : "备课", stage: s.stage,
    paused: s.paused, completed: s.units.filter(u => u.result && u.result !== "已跳过").length,
    skipped: s.units.filter(u => u.result === "已跳过").length, last: result };
}
