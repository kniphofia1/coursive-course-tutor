import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tutor from "../agent.mjs";
import { digest } from "../session.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "course-tutor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entries = [];
  let tools, hook;
  const ctx = { sessionManager: { getSessionId: () => "session1", getBranch: () => entries } };
  const api = { storage: { dir: async () => dir }, daemon: { get: async path => {
    if (path === "/api/courses/c/lectures") return { course: { id: "c" }, lectures: [{ id: "l", title: "同步" }] };
    if (path === "/api/lectures/l/transcript?from_ms=0&to_ms=90000") return [{start_ms: 8000, end_ms: 12000, text: "等待线程在唤醒后要重新检查条件。"}];
    if (path.includes("/transcript?")) return [];
    if (path.includes("/courseware/text?")) return { name: "同步", text: "获得锁后再次检查条件。", more: false };
    throw new Error(path);
  }}};
  function load() {
    tools = {};
    tutor({ registerTool: d => tools[d.name] = d, on: (_, h) => hook = h }, api);
  }
  load();
  const say = text => entries.push({ id: String(entries.length + 1), type: "message",
    message: { role: "user", content: [{ type: "text", text: "<context>\ncourse_id: c\n</context>\n\n" + text }] } });
  say("带我复习");
  const call = async (name, args = {}) => JSON.parse((await tools[name].execute("call", args, undefined, undefined, ctx)).content[0].text);
  const act = async (name, args = {}) => call(name, { revision: (await call("status")).revision, ...args });
  const start = () => act("start", {course_id:"c", goal:"线程同步"});
  return { call, act, say, load, start, ctx, dir, hook: () => hook({}, ctx) };
}
const quiz = (source, question) => ({source, lesson:"唤醒的线程要竞争锁。", question,
  options:["重新检查", "直接执行"], answer_index:0, rationale:"重新获得锁时共享状态可能已变。"});
test("证据、等待真实输入、错题变式、暂停和恢复、迁移检验", async t => {
  const f = await fixture(t);
  await f.start();
  await assert.rejects(f.act("plan", {units:[{title:"锁",source:"e_fake"}]}), /先读/);
  await assert.rejects(f.act("read_material",{lecture_id:"wrong"}), /不属于/);
  await assert.rejects(f.act("read_material",{lecture_id:"l",position:300}), /没有可读材料/);
  const e = await f.act("read_material", {lecture_id:"l"});
  assert.equal(e.link,"coursive://lecture/l?t=8");
  const e2 = await f.act("read_material", {lecture_id:"l", file:"sync.md"});
  assert.match(e2.link,/coursive:\/\/courseware/);
  await f.act("plan", {units:[{title:"锁",source:e.id}]});
  const first = await f.act("teach", quiz(e.id,"醒来后做什么？"));
  assert.equal(first.pending.options.length, 2);
  assert.doesNotMatch(JSON.stringify(first), /重新获得锁时共享状态可能已变|answer_index/);
  await assert.rejects(f.act("answer"), /下一条/);
  f.say("再解释一下"); await assert.rejects(f.act("answer"), /还未计分/);
  f.say("暂停"); await f.act("control",{action:"pause"});
  f.load(); assert.equal((await f.call("status")).paused,true);
  await assert.rejects(f.act("answer"), /已暂停/);
  f.say("继续"); await f.act("control",{action:"resume"});
  f.say("B"); const wrong = await f.act("answer");
  assert.equal(wrong.stage,"repair"); assert.equal(wrong.attempts,1);
  await assert.rejects(f.act("teach", quiz(e.id,"醒来后做什么？")), /已经练过/);
  await f.act("teach", quiz(e.id,"另一个消费者先运行，要做什么？"));
  await assert.rejects(f.act("answer"), /下一条/);
  f.say("A"); assert.equal((await f.act("answer")).stage,"transfer");
  await f.act("teach", quiz(e2.id,"资源池发出通知后怎么办？"));
  f.say("1"); const done = await f.act("answer");
  assert.equal(done.stage,"finished"); assert.equal(done.transfer,"答对");
  assert.equal(done.units[0].mistakes,1); assert.equal(done.attempts,3);
  await assert.rejects(f.act("answer"));
});
test("旧版本和重复并发请求不会覆盖进度；新会话隔离", async t => {
  const f = await fixture(t);
  const pair = await Promise.allSettled([f.start(), f.start()]);
  assert.equal(pair.filter(r=>r.status==="fulfilled").length,1);
  await assert.rejects(f.call("read_material",{revision:0,lecture_id:"l"}),/进度已变化/);
  f.ctx.sessionManager.getSessionId=()=>"new";
  assert.equal((await f.call("status")).stage,"new");
});
test("损坏的进度文件保留原样", async t=>{
  const f=await fixture(t);
  const path=join(f.dir,"lesson-"+digest("session1")+".json");
  await writeFile(path,"broken");
  await assert.rejects(f.start(),/无法读取/);
  assert.equal(await readFile(path,"utf8"),"broken");
});
test("提到跳过不等于同意；一次明确跳过只影响一个单元", async t=>{
  const f=await fixture(t); await f.start();
  const e=await f.act("read_material",{lecture_id:"l"});
  await f.act("plan",{units:[{title:"一",source:e.id},{title:"二",source:e.id}]});
  f.say("不要跳过"); await assert.rejects(f.act("control",{action:"skip"}),/明确/);
  f.say("跳过"); const s=await f.act("control",{action:"skip"});
  assert.equal(s.units[0].result,"已跳过"); assert.equal(s.unit,"二");
  await assert.rejects(f.act("control",{action:"skip"}),/无法跳过/);
});
test("简答须由学生明确提交，模型评阅须引用真实答卷",async t=>{
  const f=await fixture(t); await f.start();
  const e=await f.act("read_material",{lecture_id:"l"});
  await f.act("plan",{units:[{title:"同步",source:e.id}]});
  await f.act("teach",{source:e.id,lesson:"考虑突然改变的共享状态。",question:"解释为什么要重新检查。",
    criteria:["提到共享条件改变"],rationale:"唤醒后竞争锁。"});
  f.say("什么意思"); await assert.rejects(f.act("answer"),/追问/);
  f.say("作答：共享条件可能改变。"); const answer=await f.act("answer");
  assert.equal(answer.stage,"review_written"); assert.equal(answer.pending.review.response,"共享条件可能改变。");
  await assert.rejects(f.act("review_written",{checks:[{met:true,quote:"用户没说",reason:"错引"}]}),/实际写下/);
  const done=await f.act("review_written",{checks:[{met:true,quote:"共享条件可能改变",reason:"指出状态可能变化。"}]});
  assert.equal(done.stage,"transfer"); assert.equal(done.last.assessment,"模型按判据评阅");
});
