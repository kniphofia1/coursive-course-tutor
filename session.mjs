import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const locks = new Map();
export const digest = (s) => createHash("sha256").update(s).digest("hex");

export function string(value, title, max = 400) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new Error(`请提供有效的${title}（最多 ${max} 个字符）。`);
  return value.trim();
}

export function turn(ctx) {
  const manager = ctx?.sessionManager;
  const session = manager?.getSessionId?.();
  if (!session) throw new Error("请在小 C 对话中打开课程伴学。");
  const message = manager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user");
  if (!message?.id) throw new Error("尚未收到学生消息。");
  const content = message.message.content;
  const body = Array.isArray(content)
    ? content.filter(part => part.type === "text").map(part => part.text).join("\n")
    : String(content ?? "");
  return { session, id: message.id, body: body.replace(/^<context>[\s\S]*?<\/context>\s*/, "").trim() };
}

export async function withSession(api, session, signal, run) {
  // Host denies storage.dir() in background tasks. One file per conversation,
  // atomic replacement and a shared lock across Pi factories in this process.
  const file = join(await api.storage.dir(), `lesson-${digest(session)}.json`);
  const previous = locks.get(file) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    let state;
    try { state = JSON.parse(await readFile(file, "utf8")); }
    catch (err) { if (err.code !== "ENOENT") throw new Error("伴学记录无法读取，已保留原文件。"); }
    if (state && (state.schema !== 1 || !Number.isInteger(state.revision) || !Array.isArray(state.attempts)))
      throw new Error("伴学记录格式不受支持，请保留原文件。");
    const { save, result } = await run(state);
    if (save) {
      signal?.throwIfAborted();
      save.revision = (state?.revision ?? 0) + 1;
      const tmp = file + "." + randomUUID();
      try {
        await writeFile(tmp, JSON.stringify(save), { mode: 0o600, flag: "wx" });
        signal?.throwIfAborted();
        await rename(tmp, file);
      } finally { await rm(tmp, { force: true }); }
    }
    return result ?? summary(save ?? state);
  });
  locks.set(file, job);
  try { return await job; }
  finally { if (locks.get(file) === job) locks.delete(file); }
}

export function summary(s) {
  if (!s) return { stage: "new", revision: 0 };
  return {
    course: s.course, goal: s.goal, stage: s.stage, paused: s.paused,
    revision: s.revision, unit: s.units?.[s.index]?.title,
    units: s.units?.map(({ title, result, source }, index) => ({
      title, source, result: result ?? "待学习",
      mistakes: s.attempts.filter(item => item.unit === index && !item.correct).length,
    })),
    transfer: s.transfer,
    evidence: Object.values(s.sources).map(({ id, label, link }) => ({ id, label, link })),
    pending: s.pending && { question: s.pending.question, options: s.pending.options,
      format: s.pending.criteria ? "written" : "choice",
      review: s.stage === "review_written" ? { response:s.pending.response, criteria:s.pending.criteria } : undefined,
      explanation: s.pending.lesson, source: s.sources[s.pending.source].link },
    attempts: s.attempts.length, last: s.attempts.at(-1),
  };
}

export function nextUnit(s, outcome) {
  if (s.index < s.units.length) {
    s.units[s.index].result = outcome;
    s.index++;
    s.stage = s.index === s.units.length ? "transfer" : "teach";
  } else {
    s.stage = "finished";
    s.transfer = outcome;
  }
}

export function submit(s, student) {
  const q = s.pending;
  if (!q || student.id === q.turn) throw new Error("等待学生在下一条消息中作答。");
  if (s.stage !== "await_answer") throw new Error("当前没有待作答的问题。");
  if (q.criteria) {
    const match = /^(?:作答|我的答案|答)[:：]([\s\S]+)$/u.exec(student.body);
    if (!match) throw new Error("追问不会计为作答。请以“作答：”开头提交自己的回答。");
    q.response = string(match[1], "简答", 4000);
    q.responseTurn = student.id;
    s.stage = "review_written";
    return;
  }
  const choice = /^(?:我选|选项|选|答案是)?\s*([a-d1-4])\s*[。.!！]?$/i.exec(student.body)?.[1]?.toUpperCase();
  const index = choice && ("ABCD".includes(choice) ? "ABCD".indexOf(choice) : Number(choice) - 1);
  if (index == null || index >= q.options.length) throw new Error("还未计分。请学生单独回复题目对应的选项字母或序号。");
  const correct = index === q.key;
  s.attempts.push({ unit: s.index, question: q.question, options: q.options, chosen: index,
    answer: q.key, rationale: q.rationale, correct, source: q.source, turn: student.id });
  s.pending = null;
  if (correct) nextUnit(s, "答对");
  else s.stage = s.index === s.units.length ? "transfer" : "repair";
}
