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
    noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:host.extensionFactories(conv,(course,title,progress)=>memory.updateCourseProgress(course,title,progress))});
  await loader.reload();
  tools = new Map(loader.getExtensions().extensions.flatMap(ext=>[...ext.tools]));
  assert.equal(tools.size,8);
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
  assert.match(recalled,/优先举例/); assert.match(recalled,/迁移复测|已结束/);
  assert.doesNotMatch(await memory.prompt({pinnedOnly:true,courseId:"other"}),/## 伴学进度/);
  console.log("PASS: packaged plugin, installed Coursive host, Pi session, composer action, source read, turn guard, restart, transfer.");
} finally { await host?.close(); await rm(root,{recursive:true,force:true}); }
