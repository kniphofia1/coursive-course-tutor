import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { brief, digest, exclusive, jsonFile, lineage, readJournal, record, restore, writeJson } from "./course-memory.mjs";

export { digest };
const checkedLegacy = new Set();

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

export async function withSession(api, session, signal, run, options = {}) {
  const privateDir = await api.storage.dir();
  const key = digest(session);
  const bindingFile = join(privateDir, "binding-" + key + ".json");
  return exclusive(bindingFile, async () => {
    const binding = await jsonFile(bindingFile);
    const legacy = await jsonFile(join(privateDir, "lesson-" + key + ".json"));
    if (legacy && (legacy.schema !== 1 || !Number.isInteger(legacy.revision) || !Array.isArray(legacy.attempts)))
      throw new Error("伴学记录格式不受支持，已保留原文件。");
    const course = api.currentCourseId ?? options.course ?? binding?.course ?? legacy?.course;
    if (options.course && options.course !== course) throw new Error("请选择当前对话对应的课程。");
    if (!course) return (await run(null, [])).result;
    string(course, "课程 ID", 128);
    const dir = await api.workspace("course-" + digest(course).slice(0, 48));
    return exclusive(dir, async () => {
      signal?.throwIfAborted();
      const journal = await readJournal(dir);
      const roots = new Set([...journal.events.values()].filter(e => !e.parent).map(e => e.fields.planId));
      const candidates = new Map();
      if (!checkedLegacy.has(dir)) {
        for (const name of await readdir(privateDir)) {
          const match = /^lesson-([a-f0-9]{64})\.json$/.exec(name);
          if (!match || roots.has(match[1])) continue;
          // A damaged legacy file remains available to its original session for diagnosis.
          let old;
          try { old = await jsonFile(join(privateDir, name)); } catch { continue; }
          if (old?.course === course && old.schema === 1 && Number.isInteger(old.revision) && Array.isArray(old.attempts))
            candidates.set(match[1], old);
        }
      }
      if (legacy?.course === course && !roots.has(key)) candidates.set(key, legacy);
      for (const [planId, old] of candidates) {
        const lectures = old.lectures.map(({id, title}) => ({id, title}));
        await record(dir, null, null, { ...old, planId, lectures });
      }
      if (candidates.size) Object.assign(journal, await readJournal(dir));
      checkedLegacy.add(dir);
      const plans = journal.heads.map(head => ({ head, state: restore(journal.events, head) }))
        .filter(p => !p.state.sections || !p.state.noteId)
        .sort((a,b) => (a.state.updatedAt ?? 0) - (b.state.updatedAt ?? 0));
      if (plans.some(p => p.state.course !== course)) throw new Error("课程记录与当前课程不匹配。");
      const history = plans.map(p => ({ checkpoint: p.head, ...brief(p.state) }));
      let choices = plans;
      if (options.checkpoint) {
        choices = plans.filter(p => p.head === options.checkpoint);
        if (!choices.length) throw new Error("该进度已更新，请重新查看课程进度。");
      } else {
        const previous = binding?.course === course && binding.head;
        const own = previous ? plans.filter(p => lineage(journal.events, p.head).includes(previous))
          : plans.filter(p => p.state.planId === key);
        const active = plans.filter(p => p.state.stage !== "finished");
        choices = own.length ? own : active;
      }
      if (choices.length > 1) {
        if (!options.readOnly) throw new Error("课程有多份进度，请先用 status 选择 checkpoint。");
        return { stage: "choose_plan", revision: 0, course, history };
      }
      const chosen = choices[0];
      const before = chosen?.state;
      const { save, result } = await run(before ? structuredClone(before) : null, history);
      let head = chosen?.head;
      if (save) {
        signal?.throwIfAborted();
        if (save.course !== course) throw new Error("不能将学习记录写入另一门课。");
        const newPlan = !before || (options.start && before.stage === "finished");
        save.planId = newPlan ? (before || history.length ? randomUUID() : key) : before.planId;
        save.updatedAt = Date.now();
        save.revision = (newPlan ? 0 : before.revision) + 1;
        head = await record(dir, newPlan ? null : head, newPlan ? null : before, save);
      }
      if (head && (save || options.checkpoint || options.bind) && (binding?.head !== head || binding.course !== course))
        await writeJson(bindingFile, { course, head });
      const response = result ?? summary(save ?? before);
      if (save && api.reportCourseProgress) {
        try { await api.reportCourseProgress(course, save.courseTitle, brief(save)); }
        catch (error) { return { ...response, memoryWarning: "进度已保存，课程记忆摘要未更新：" + error.message }; }
      }
      return response;
    });
  });
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
