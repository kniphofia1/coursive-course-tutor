// Usage: node test/installed-host.mjs <Coursive agent directory> <unpacked plugin> [local reading]
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const [agent, plugin, reading] = process.argv.slice(2).map(v => resolve(v));
const installed = rel => import(pathToFileURL(join(agent, rel)).href);
const { PluginHost } = await installed("src/plugins.mjs");
const { DefaultResourceLoader, SessionManager } = await installed("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const { guard } = await installed("src/tools.mjs");
const root = await mkdtemp(join(tmpdir(), "coursive-course-tutor-installed-"));
const courseware = reading ? await readFile(reading, "utf8") : "条件变量用于等待共享条件。";
const fixture = {
  "/api/courses/c/lectures": {course:{id:"c"},lectures:[{id:"l",title:"同步"}]},
  "/api/lectures/l/courseware/text?path=reading.md&offset=0&max=1600": {name:"reading.md",text:courseware.slice(0,1600),more:false},
};
let manager = SessionManager.inMemory(root);
const conv = {calls:0, kind:"course", course_id:"c"};
const { MemoryStore } = await installed("src/memory.mjs");
const memory = new MemoryStore(join(root,"data","bot","memory"));
await memory.init();
await memory.write("preferences.md", "优先举例");
let host, tools;
async function boot(install) {
  host = new PluginHost({ dataDir:join(root,"data"), libraryRoot:join(root,"library"),
    bundledDir:join(root,"bundled"), guard, convOf:()=>conv,
    daemon:async (method,path) => {
      assert.equal(method,"GET"); assert.ok(Object.hasOwn(fixture,path),path); return fixture[path];
    } });
  await host.init();
  if (install) {
    await host.setAllowThirdParty(true);
    const view = await host.confirm((await host.preview("path:"+plugin)).token);
    assert.equal(view.state,"enabled");
    assert.match((await host.runAction("course-tutor","tutor")).prompt,/课程伴学/);
  }
  const loader = new DefaultResourceLoader({cwd:root,agentDir:root,noExtensions:true,noSkills:true,
    noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:host.extensionFactories(conv)});
  await loader.reload();
  tools = new Map(loader.getExtensions().extensions.flatMap(ext=>[...ext.tools]));
  assert.ok(tools.has("course-tutor__status") && tools.has("course-tutor__answer"));
}
const call = async (name,params={}) => JSON.parse((await tools.get("course-tutor__"+name).definition.execute(
  "smoke",params,undefined,undefined,{sessionManager:manager})).content[0].text);
function say(text) {
  conv.calls=0;
  manager.appendMessage({role:"user",content:[{type:"text",text}],timestamp:Date.now()});
}
try {
  await mkdir(join(root,"bundled")); await writeFile(join(root,"bundled","catalog.json"),'{"name":"test","plugins":[]}');
  await boot(true); say("带我复习条件变量");
  await call("start",{course_id:"c",goal:"了解条件变量",revision:0});
  const src=await call("read_material",{lecture_id:"l",file:"reading.md",revision:1});
  await call("plan",{units:[{title:"线程同步",source:src.id}],revision:2});
  await call("teach",{source:src.id,revision:3,question:"醒来后应先做什么？",options:["重新检查条件","直接继续"],
    answer_index:0,lesson:"唤醒后仍需检查共享状态。",rationale:"另一个线程可能已经改变条件。"});
  await assert.rejects(call("answer",{revision:4}),/下一条/);
  await host.close();
  manager = SessionManager.inMemory(root);
  say("接着学"); await boot(false);
  assert.equal((await call("status")).stage,"await_answer");
  say("A"); assert.equal((await call("answer",{revision:4})).stage,"transfer");
  await call("teach",{source:src.id,revision:5,question:"消费者竞争单个资源，收到通知时怎么办？",
    options:["跳过检查","检查资源是否仍存在"],answer_index:1,lesson:"考虑另一个消费者先取得锁。",rationale:"收到通知不能保证条件仍成立。"});
  say("B"); const done=await call("answer",{revision:6});
  assert.equal(done.stage,"finished"); assert.equal(done.attempts,2);
  const recalled = await memory.prompt({pinnedOnly:true, courseId:"c"});
  assert.match(recalled,/优先举例/);
  assert.doesNotMatch(recalled,/## 伴学进度/);
  assert.equal((await call("status")).history[0].stage,"finished");
  const { runLessonStudy } = await installed("src/lesson-study.mjs");
  const notes = new Map();
  const lessonApi = async (method,path,body) => {
    if (path === "/api/lectures/l") return {lecture:{id:"l",course_id:"c",title:"同步"},course:{id:"c"}};
    if (path.endsWith("/transcript")) return [{text:"条件变量用于等待共享条件。",start_ms:42000}];
    if (path.endsWith("/courseware") || path.endsWith("/slides")) return [];
    if (path === "/api/notes" && method === "PUT") { notes.set(body.id, body); return body; }
    if (notes.has(path.split("/").at(-1))) return notes.get(path.split("/").at(-1));
    throw Object.assign(Error("fixture missing"),{status:404});
  };
  let generations = 0;
  const pipeline = {
    currentModel:async()=>({id:"fixture"}),
    runtime:{completeSimple:async(_model,{messages})=>{
      generations++;
      const input = JSON.parse(messages[0].content);
      const draft = input.material ? {sections:[{
        title:"条件变量",paragraphs:[{text:"等待共享条件。",refs:[{id:input.material[0].id,quote_index:0}]}],
        example:{text:"等待队列出现元素。",refs:[]},question:"唤醒后检查什么？",criterion:"共享条件",
      }]} : {topics:[{query:"条件变量"}]};
      return {stopReason:"stop",content:[{type:"text",text:JSON.stringify(draft)}]};
    }},
  };
  const deps = {plugins:host,call:lessonApi,pipeline,memory};
  const handout = await runLessonStudy(deps,"l",{action:"open"});
  assert.match(handout.note.body,/coursive:\/\/lecture\/l\?t=42/);
  assert.equal((await runLessonStudy(deps,"l",{action:"open"})).pending.id,handout.pending.id);
  assert.equal(generations,2);
  conv.course_id = "other";
  assert.equal((await call("status")).history.length,0);
  console.log("PASS: packaged plugin, installed Coursive host, Pi session, composer action, source read, turn guard, restart, transfer.");
} finally { await host?.close(); await rm(root,{recursive:true,force:true}); }
