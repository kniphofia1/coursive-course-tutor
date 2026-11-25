import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,cp,readdir,copyFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {lessonStudy,lessonHistory} from "../lesson.mjs";
const excerpt="老师说要注意先保存现场。";
const src={id:"e1",text:"上次讲到进程。\n"+excerpt,kind:"transcript",link:"coursive://lecture/l?t=3",label:"课堂", segments:[{at:0,seconds:3},{at:8,seconds:72}]};
const section={title:"切换",explanation:"切走前保存寄存器。",example:"切换两个编辑器。",source:"e1",quote:excerpt,teacher_emphasis:true,question:"切换时保存什么？",criterion:"说明寄存器现场"};
async function setup(t) {
 const dir=await mkdtemp(join(tmpdir(),"coursive-lesson-"));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const notes=new Map(); let generated=0, grades=0;
 const services={ materials:async()=>({sources:[src],coverage:"材料范围"}),model:async(_sys,input)=>{
   if(input.response){grades++;return {correct:input.response.includes("寄存器"),quote:input.response,feedback:"要说明寄存器。",variant:"编辑器切走后如何恢复？",criterion:"指出恢复寄存器"};}
   generated++;return {sections:[section]};
 },note:async(id,title,body)=>{if(!notes.has(id))notes.set(id,{id,title,body});return notes.get(id);}};
 const run=(action,more={},root=dir)=>lessonStudy.run(root,{course:"c",lecture:"l",title:"操作系统",action,...more},services);
 return {dir,services,notes,run,generated:()=>generated,grades:()=>grades};
}
test("讲义跳向引文的实际时间，手改正文与旁问和修订相互独立",async t=>{
 const {run,notes,generated}=await setup(t);
 const a=await run("open");assert.match(a.note.body,/t=72/);
 notes.get(a.note.id).body="学生改过的段落";
 const b=await run("open");assert.equal(b.note.body,"学生改过的段落");assert.equal(generated(),1);
 assert.equal((await run("status")).pending.id,a.pending.id);
 const r=await run("revise",{checkpoint:a.checkpoint});assert.notEqual(r.suggestion.id,a.note.id);assert.match(r.suggestion.body,/学生改过的段落/);
 assert.equal((await run("open")).note.body,"学生改过的段落");assert.equal(r.pending.id,a.pending.id);
});
test("真实作答、幂等重试、变式及重新打开恢复",async t=>{
 const {run,grades,dir}=await setup(t);const a=await run("open");
 const bookmark={quote:"老师",ratio:0.45,fraction:0.1};
 const b=await run("position",{checkpoint:a.checkpoint,bookmark});
 const input={checkpoint:b.checkpoint,submissionId:"s1",questionId:a.pending.id,answer:"只保存内存"};
 const c=await run("answer",input);
 assert.notEqual(c.pending.id,a.pending.id);assert.equal((await run("answer",input)).checkpoint,c.checkpoint);assert.equal(grades(),1);
 assert.deepEqual((await run("open")).bookmark,bookmark);
 const [record]=await lessonHistory({currentCourseId:"c",workspace:async()=>dir},"l","s1");
 assert.equal(record.attempt.response,input.answer);assert.deepEqual(await lessonHistory({currentCourseId:"other",workspace:async()=>dir}),[]);
 const done=await run("answer",{checkpoint:c.checkpoint,submissionId:"s2",questionId:c.pending.id,answer:"保存寄存器"});assert.equal(done.stage,"finished");
});
test("双端离线作答后保留两条可恢复进度",async t=>{
 const {dir,run}=await setup(t);const start=await run("open");
 const peer=await mkdtemp(join(tmpdir(),"lesson-peer-"));t.after(()=>rm(peer,{recursive:true,force:true}));await cp(dir,peer,{recursive:true});
 const base={checkpoint:start.checkpoint,questionId:start.pending.id};
 const a=await run("answer",{...base,submissionId:"left",answer:"寄存器"});
 const b=await run("answer",{...base,submissionId:"right",answer:"内存"},peer);
 for(const f of await readdir(peer))await copyFile(join(peer,f),join(dir,f));
 const {branches}=await run("open");assert.equal(branches.length,2);
 assert.equal((await run("open",{checkpoint:a.checkpoint})).stage,"finished");
 assert.equal((await run("open",{checkpoint:b.checkpoint})).pending.id,b.pending.id);
});
test("拒绝伪造引文或教师强调，失败不会留下保存点",async t=>{
 const {run,services,dir}=await setup(t);
 services.model=async()=>({sections:[{...section,quote:"老师没说这句话"}]});
 await assert.rejects(run("open"),/引文/);assert.deepEqual(await readdir(dir),[]);
 services.model=async()=>({sections:[{...section,quote:"上次讲到进程。"}]});
 await assert.rejects(run("open"),/强调/);
});
test("模型选择片段编号，讲义使用原文和该段时间", async t => {
  const { run, services } = await setup(t);
  const first = "甲".repeat(70) + "。";
  const second = "乙".repeat(66) + "。";
  services.materials = async () => ({
    sources: [{ ...src, text: first + second,
      segments: [{ at: 0, seconds: 4 }, { at: first.length, seconds: 51 }] }],
  });
  services.model = async (_prompt, { material }) => {
    assert.deepEqual(material[0].passages, [first, second]);
    return { sections: [{ ...section, source: "S1", quote_index: 1, quote: "转述", teacher_emphasis: false }] };
  };
  const { note } = await run("open");
  assert.ok(note.body.includes("> " + second));
  assert.match(note.body, /t=51/);
  assert.ok(!note.body.includes("转述"));
});

test("按知识点补查不同材料并把已读出处附在相应段落", async t => {
  const {run,services} = await setup(t);
  const slide = {id:"diagram",kind:"slide",text:"流程图",label:"课件截图 3",link:"coursive://slide/l/3"};
  const exam = {id:"exam",kind:"courseware",role:"past_exam",text:"描述状态切换",link:"coursive://courseware/l?file=exam"};
  const calls = [];
  services.evidence = async () => ({
    catalog:{timeline:[],files:[]},
    lookup:async query => {
      calls.push(query);
      return query === "切换" ? [src] : [slide,exam];
    },
    coverage:() => "截图已查看",
  });
  let rounds = 0;
  services.model = async (_prompt,input) => {
    if (++rounds === 1) return {topics:[{query:"切换"}]};
    if (rounds === 2) return {lookup:[{query:"流程图"}]};
    assert.deepEqual(input.material.map(m=>m.id),["e1","diagram","exam"]);
    const ref = id => ({id,quote_index:0});
    return {sections:[{title:"如何切换？",paragraphs:[
      {text:"看流程图理解课堂例子。",refs:[ref("e1"),ref("diagram")]},
      {text:"先保存现场再继续。",refs:[ref("e1")]},
    ],example:{text:"两个编辑器的例子。",refs:[]},question:"何时恢复现场？",criterion:"说明切换顺序",
    exam_refs:[ref("exam")]}]};
  };
  const state = await run("open");
  assert.deepEqual(calls,["切换","流程图"]);
  assert.match(state.note.body,/看流程图理解课堂例子。[\s\S]*?!\[课件截图 3\]\(coursive:\/\/slide\/l\/3\)[\s\S]*?课堂 · 回听[\s\S]*?课件截图 3[\s\S]*?先保存现场再继续。/);
  const [explanation,exercise] = state.note.body.split("**自测**");
  assert.doesNotMatch(explanation,/往年题/);
  assert.match(exercise,/练习参考.*往年题/);
  assert.equal((await run("open")).note.body,state.note.body);
  assert.equal(rounds,3);
});

test("补查过的往年卷仍不能替代讲解依据",async t=>{
  const {run,services,dir}=await setup(t);
  const exam={...src,id:"exam",role:"past_exam"};
  services.evidence=async()=>({
    catalog:{}, lookup:async()=>[src,exam],coverage:()=>"",
  });
  services.model=async(_prompt,input)=>input.material?{sections:[{
    title:"故意错误",paragraphs:[{text:"讲解",refs:[{id:"exam",quote_index:0}]}],
    example:{text:"例子",refs:[]}, question:"问题",criterion:"判据"
  }]}:{topics:[{query:"切换"}]};
  await assert.rejects(run("open"),/已读且用途对应/);
  assert.deepEqual(await readdir(dir),[]);
});
