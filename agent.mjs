import { digest, nextUnit, string, submit, summary, turn, withSession } from "./session.mjs";

const str = { type: "string" };
const integer = { type: "integer", minimum: 0 };
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const encode = encodeURIComponent;

export function activate(api) {
  api.action("tutor", async () => ({ prompt: "请用课程伴学带我复习当前课程。如果已有进度就继续；否则先确认本次目标，再读课程资料安排学习。" }));
}

export default function tutor(pi, api) {
  function tool(name, label, description, properties, required, handle) {
    pi.registerTool({
      name, label, description, parameters: object(properties, required),
      async execute(_call, args, signal, _update, ctx) {
        const student = turn(ctx);
        const result = await withSession(api, student.session, signal, async state => {
          if (required.includes("revision") && args.revision !== (state?.revision ?? 0))
            throw new Error("进度已变化。先读取 status，再决定下一步。");
          if (name !== "start" && name !== "status" && !state) throw new Error("先指定课程并开始伴学。");
          if (state?.paused && !["status", "control"].includes(name)) throw new Error("带练已暂停。");
          return handle(state, args, student);
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      },
    });
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const id = ctx.sessionManager?.getSessionId();
    if (!id) return;
    const info = await withSession(api, id, undefined, async s => ({ result: s ? { stage: s.stage, paused: s.paused } : {} }));
    if (!info.stage || info.stage === "finished") return;
    const mode = info.paused ? "带练已暂停，按普通对话回应。只有学生明确续学时恢复。" :
      "本对话正在课程伴学。先加载 plugin:course-tutor 并用 status 恢复；学生旁问时回答旁问，不替其作答或跳过题目。";
    return { systemPrompt: event.systemPrompt + "\n" + mode };
  });

  tool("status", "查看伴学进度", "Read the current tutoring checkpoint and revision. If source_id is given, reopen the exact saved excerpt.",
    { source_id: str }, [], async (s, a) => {
      if (a.source_id) {
        const source = Object.values(s?.sources ?? {}).find(item => item.id === a.source_id);
        if (!source) throw new Error("找不到该材料摘录。");
        return { result: source };
      }
      return { result: summary(s) };
    });

  tool("start", "开始课程伴学", "Start a course tutoring session for the user's goal. Use the course ID from the current course or list_courses; new conversations have revision 0.",
    { course_id: str, goal: str, revision: integer }, ["course_id", "goal", "revision"], async (s, a) => {
      if (s) throw new Error("此对话已有计划，可继续进度；新目标可开新对话。");
      const course = string(a.course_id, "课程 ID", 128);
      const goal = string(a.goal, "复习目标");
      const catalog = await api.daemon.get(`/api/courses/${encode(course)}/lectures`);
      if (String(catalog.course?.id) !== course || !Array.isArray(catalog.lectures) || !catalog.lectures.length)
        throw new Error("没有找到这门课的节次。先导入材料或选择已有课程。");
      const lectures = catalog.lectures.map(l => ({ id: String(l.id), title: l.title, assets: l.assets }));
      const save = { schema: 1, revision: 0, course, goal, lectures, stage: "prepare", paused: false,
        sources: {}, units: [], attempts: [], index: 0, pending: null };
      return { save, result: { revision: 1, course, goal, lectures } };
    });

  tool("read_material", "读取教学依据", "Read a transcript window (position in seconds) or a parsed courseware file (position in characters). List files with the built-in courseware tools. Returns a reusable evidence ID.",
    { lecture_id: str, file: str, position: integer, revision: integer }, ["lecture_id", "revision"], async (s, a) => {
      const id = a.lecture_id;
      if (!s.lectures.some(l => l.id === id)) throw new Error("该节次不属于当前课程。");
      const pos = a.position ?? 0;
      if (!Number.isSafeInteger(pos) || pos < 0 || pos > 1e8) throw new Error("材料位置无效。");
      const base = `/api/lectures/${encode(id)}`;
      let text, link, label, next;
      if (a.file) {
        const file = string(a.file, "课件名", 1024);
        const r = await api.daemon.get(`${base}/courseware/text?path=${encode(file)}&offset=${pos}&max=1600`);
        text = r.text?.trim();
        label = r.name;
        next = r.more ? r.next : null;
        link = `coursive://courseware/${encode(id)}?file=${encode(file)}&q=${encode((text ?? "").slice(0, 28))}`;
      } else {
        const segments = await api.daemon.get(`${base}/transcript?from_ms=${pos*1000}&to_ms=${(pos+90)*1000}`);
        const rows = segments.filter(row => typeof row.text === "string" && row.text.trim() && Number.isFinite(row.start_ms));
        text = rows.map(row => row.text.trim()).join(" ").slice(0, 2400);
        if (rows.length) {
          const sec = Math.floor(rows[0].start_ms / 1000);
          label = `${s.lectures.find(l => l.id === id).title} · ${sec} 秒`;
          link = `coursive://lecture/${encode(id)}?t=${sec}`;
          next = pos + 90;
        }
      }
      if (!text) throw new Error("这个位置没有可读材料。请换一个时间段或已解析的课件。");
      const source = { id: "e_" + digest(JSON.stringify([id, link, pos, text])).slice(0, 20), label, link, text, position: pos };
      if (!Object.hasOwn(s.sources, source.id) && Object.keys(s.sources).length >= 80)
        throw new Error("此计划已保存 80 段依据，请复用已有摘录或开启新计划。");
      s.sources[source.id] = source;
      return { save: s, result: { ...source, next, revision: s.revision + 1 } };
    });

  const unit = object({ title: str, source: str }, ["title","source"]);
  tool("plan", "安排学习单元", "Save a sequence of units tied to actual evidence IDs after reading course material.",
    { units: { type: "array", minItems: 1, maxItems: 10, items: unit }, revision: integer }, ["units","revision"], async (s, a) => {
      if (s.stage !== "prepare") throw new Error("该计划已经开始。");
      if (!Array.isArray(a.units) || !a.units.length || a.units.length > 10) throw new Error("请安排 1 至 10 个学习单元。");
      s.units = a.units.map(u => {
        if (!Object.hasOwn(s.sources, u.source)) throw new Error("先读该单元的课程材料。");
        return { title: string(u.title, "单元目标", 150), source: u.source };
      });
      s.stage = "teach";
      return { save: s };
    });

  tool("teach", "讲解并发题", "Present one grounded explanation and one new choice or written-response question. For written work supply rubric criteria instead of options and key. Use a different scenario for remediation or final transfer; stop and await the learner.",
    { lesson: str, question: str, options: { type: "array", items: str, minItems: 2, maxItems: 4 },
      criteria: { type: "array", items: str, minItems: 1, maxItems: 4 },
      answer_index: { type: "integer", minimum: 0, maximum: 3 }, rationale: str, source: str, revision: integer },
    ["lesson","question","rationale","source","revision"], async (s, a, student) => {
      if (!["teach","repair","transfer"].includes(s.stage)) throw new Error("先完成当前活动。");
      if (!Object.hasOwn(s.sources, a.source)) throw new Error("引用必须来自当前课程已读取的材料。");
      const question = string(a.question, "题干", 800);
      if (s.attempts.some(item => item.question === question)) throw new Error("已经练过这道题，请换一个情境。");
      const criteria = a.criteria?.map(v => string(v, "判据", 240));
      const options = a.options?.map(v => string(v, "选项", 300));
      if (criteria) {
        if (!criteria.length || criteria.length > 4 || options || a.answer_index !== undefined)
          throw new Error("简答题需要 1 至 4 条判据，无需选项和答案编号。");
      } else if (!options || options.length < 2 || options.length > 4 || new Set(options).size !== options.length ||
          !Number.isInteger(a.answer_index) || !options[a.answer_index]) throw new Error("检查选项和答案编号。");
      s.pending = { lesson: string(a.lesson,"讲解", 2000), question, options, criteria, key: a.answer_index,
        rationale: string(a.rationale, "解析", 1000), source: a.source, turn: student.id };
      s.stage = "await_answer";
      return { save: s };
    });

  tool("answer", "核对学生作答", "Grade only the latest actual user message in this conversation. No model-supplied answer is accepted.",
    { revision: integer }, ["revision"], async (s, _a, student) => {
      submit(s, student);
      return { save: s };
    });

  const check = object({ met: { type:"boolean" }, quote: str, reason: str }, ["met","quote","reason"]);
  tool("review_written", "反馈简答题", "Assess the learner's submitted text against every stored criterion in order. Quote their actual words for each met criterion.",
    { checks: { type:"array", items:check }, revision:integer }, ["checks","revision"], async (s,a) => {
      const q = s.pending;
      if (s.stage !== "review_written" || !q?.response) throw new Error("还没有收到已提交的简答。");
      if (!Array.isArray(a.checks) || a.checks.length !== q.criteria.length) throw new Error("请逐条核对出题时的判据。");
      const checks = a.checks.map((c,i) => {
        if (typeof c.met !== "boolean" || typeof c.quote !== "string" ||
          (c.met && !c.quote.trim()) || (c.quote && !q.response.includes(c.quote)))
          throw new Error("反馈须引用学生实际写下的文字；未提及的判据可留空引文。");
        return { criterion:q.criteria[i], met:c.met, quote:c.quote, reason:string(c.reason,"反馈",500) };
      });
      const correct = checks.every(c => c.met);
      s.attempts.push({unit:s.index, question:q.question, response:q.response, checks, correct,
        source:q.source, turn:q.responseTurn, assessment:"模型按判据评阅"});
      s.pending = null;
      if (correct) nextUnit(s,"通过简答评阅");
      else s.stage = s.index === s.units.length ? "transfer" : "repair";
      return {save:s};
    });

  tool("control", "暂停、续学或跳过", "Apply an explicit learner command to pause, resume, or skip. Skipped units remain marked as such.",
    { action: { enum: ["pause","resume","skip"], type: "string" }, revision: integer }, ["action","revision"], async (s, a, student) => {
      const commands = {
        pause: /^(?:请|先)?(?:暂停|停一下|pause)(?:一下|带练|复习|伴学)?[。！!]?$/i,
        resume: /^(?:请)?(?:继续|恢复|续学|resume)(?:上次的)?(?:带练|复习|课程伴学|伴学)?[。！!]?$/i,
        skip: /^(?:请|先)?(?:跳过|skip)(?:这道题|这题|本题|这一单元|这个单元|本单元)?[。！!]?$/i,
      };
      if (!commands[a.action]?.test(student.body) || s.stage === "finished") throw new Error("需要学生明确选择有效的操作。");
      if (a.action === "skip") {
        if (s.paused || !s.units.length || s.lastSkipTurn === student.id) throw new Error("当前无法跳过。");
        s.lastSkipTurn = student.id;
        s.pending = null;
        nextUnit(s, "已跳过");
      } else s.paused = a.action === "pause";
      return { save: s };
    });
}
