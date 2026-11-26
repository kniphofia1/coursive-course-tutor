import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
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
  const api = { workspace: async name => {
    const path = join(dir, name); await mkdir(path, {recursive:true}); return path;
  }, storage: { dir: async () => dir }, daemon: { get: async path => {
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
  return { call, act, say, load, start, ctx, dir, api, hook: () => hook({}, ctx) };
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

test("同课新对话自动续学；新课只读全局背景；旁问与恢复摘要不泄题",async t=>{
  const f=await fixture(t);
  f.api.currentCourseId="c";
  await f.start();
  const e=await f.act("read_material",{lecture_id:"l"});
  await f.act("plan",{units:[{title:"锁",source:e.id}]});
  await f.act("teach",quiz(e.id,"尚未作答的题干"));
  f.ctx.sessionManager.getSessionId=()=>"other-thread";
  f.load();
  const prompt=(await f.hook()).systemPrompt;
  assert.match(prompt,/线程同步/);
  assert.doesNotMatch(prompt,/尚未作答的题干|重新检查|重新获得锁/);
  assert.equal((await f.call("status")).stage,"await_answer");
  f.say("解释一次");
  await assert.rejects(f.act("answer"),/还未计分/);
  f.say("B");
  assert.equal((await f.act("answer")).stage,"repair");
  f.api.currentCourseId="unrelated";
  assert.equal((await f.call("status")).stage,"new");
  assert.equal(await f.hook(),undefined);
  await assert.rejects(f.call("status",{course_id:"c"}),/当前对话/);
});

test("旧会话原样保留，迁入同课后重启可读，重复读取不会重复出题",async t=>{
  const f=await fixture(t);
  f.api.currentCourseId="c";
  const legacy={schema:1,revision:9,course:"c",goal:"旧的复习",lectures:[],sources:{},units:[],index:0,attempts:[],stage:"prepare",paused:false};
  const path=join(f.dir,"lesson-"+digest("session1")+".json");
  await writeFile(path,JSON.stringify(legacy));
  f.ctx.sessionManager.getSessionId=()=>"new-device-session";
  assert.equal((await f.call("status")).revision,9);
  assert.equal((await f.call("status")).goal,"旧的复习");
  assert.equal((await f.call("status")).history.length,1);
  assert.deepEqual(JSON.parse(await readFile(path,"utf8")),legacy);
});

test("写入的是当前课程摘要；写摘要失败时，已计分作答仍能恢复",async t=>{
  const f=await fixture(t), reports=[];
  f.api.currentCourseId="c";
  f.api.reportCourseProgress=(id,name,brief)=>reports.push({id,brief});
  await f.start();
  const e=await f.act("read_material",{lecture_id:"l"});
  await f.act("plan",{units:[{title:"信号量",source:e.id}]});
  await f.act("teach",quiz(e.id,"测试题干"));
  f.say("B"); await f.act("answer");
  const row=reports.at(-1);
  assert.equal(row.id,"c");
  assert.equal(row.brief.last.outcome,"最近答错，待复测");
  assert.doesNotMatch(JSON.stringify(row),/测试题干|重新获得锁/);
  f.api.reportCourseProgress=()=>{throw new Error("磁盘满");};
  f.say("暂停"); const result=await f.act("control",{action:"pause"});
  assert.match(result.memoryWarning,/磁盘满/);
  assert.equal((await f.call("status")).paused,true);
});

test("离线分支可分别恢复；未选择时禁止改写",async t=>{
  const {readJournal,record,restore}=await import("../course-memory.mjs");
  const f=await fixture(t); f.api.currentCourseId="c"; await f.start();
  const dir=await f.api.workspace("course-"+digest("c").slice(0,48));
  const {events,heads:[base]}=await readJournal(dir), old=restore(events,base);
  const left=await record(dir,base,old,{...old,revision:2,goal:"分支甲"});
  const right=await record(dir,base,old,{...old,revision:2,goal:"分支乙"});
  assert.equal((await f.call("status")).stage,"choose_plan");
  await assert.rejects(f.call("control",{action:"pause",revision:2}),/多份进度/);
  assert.equal((await f.call("status",{checkpoint:left})).goal,"分支甲");
  assert.equal((await f.call("status")).goal,"分支甲");
  assert.equal((await f.call("status",{checkpoint:right})).goal,"分支乙");
});
