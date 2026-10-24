import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ImageTasks } from '../plugins/image-generation/lib/tasks.mjs';
import { normalizeManifest } from '../src/plugins/manifest.mjs';
import { snapshotDigest } from '../plugins/image-generation/lib/config.mjs';
import { createMediaDelivery } from '../src/plugins/delivery.mjs';
import { createChatFactory } from '../src/plugins/host-chat.mjs';
import { createSequencer } from '../src/reply/send.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const caller=(id='10001',convKey='group:60001',callId=Math.random().toString())=>({origin:'group',convKey,requester:{id,nickname:'test'},callId,messageId:1});
const evt=(quote,over={})=>({convKey:'private:90001',sender:{userId:'90001'},replyTo:{messageId:quote},text:'1',...over});
const config={apiUrl:'http://127.0.0.1:1/v1',model:'mock-image',admins:'90001',deliveryRetryMs:100,requestsPerHour:100,imagesPerDay:1000,maxPending:100,maxPerRequester:20};
const image=()=>[{buffer:PNG,mime:'image/png',extension:'png'}];
async function world(t,options={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ling-image-'));
  const sent=[]; const delivered=[]; let requests=0;
  const engine=new ImageTasks({dataDir:dir,config:{...config,...options.config},apiKey:'local-test-key',
    sendText:async(convKey,text)=>{sent.push({convKey,text,messageId:String(-100-sent.length)});return {ok:true,messageId:sent.at(-1).messageId};},
    deliverMedia:async(input)=>{delivered.push(input);return {ok:true,messageId:900+delivered.length,handle:`media:${delivered.length}`};},
    generate:async(input)=>{requests++; return image();},...options});
  await engine.init();
  t.after(async()=>{await engine.dispose();await engine.idle();await engine.releaseLock();await fs.rm(dir,{recursive:true,force:true});});
  return {engine,dir,sent,delivered,get requests(){return requests;}};
}
async function submit(w,c=caller(),args={prompt:'雪地里的小猫'}) {
  const r=await w.engine.submit(args,c); assert.equal(r.ok,true);assert.equal(r.status,'pending');
  for(let i=0;i<200 && !w.engine.db.tasks.find((t)=>t.id===r.taskId)?.approvals.length;i++) await new Promise((resolve)=>setTimeout(resolve,2));
  return {r,c,quote:w.sent.find((s)=>s.text.includes(r.taskId)).messageId};
}
async function approve(w,q) {assert.equal(await w.engine.handleMessage(evt(q)),true);await w.engine.idle();}

test('插件清单自包含，收费工具明确R2/paid/plugin审批',async()=>{
  const raw=JSON.parse(await fs.readFile(new URL('../plugins/image-generation/plugin.json',import.meta.url),'utf8'));
  const m=normalizeManifest(raw,'image-generation'); assert.equal(m.ok,true,JSON.stringify(m));
  const tool=m.manifest.tools.find((x)=>x.name==='image_generate'); assert.equal(tool.risk,'R2');assert.equal(tool.approval,'plugin');assert.ok(tool.effects.includes('paid'));
});

test('提交快速返回pending，审批前零收费，严格身份/私聊/引用归属，重复审批仅一次生成',async(t)=>{
  const w=await world(t);const {r,c,quote}=await submit(w);assert.equal(w.requests,0);
  assert.equal(await w.engine.handleMessage({...evt(quote),replyTo:null}),false);
  assert.equal(await w.engine.handleMessage(evt('99999')),false);
  for(const bad of [{sender:{userId:'80001'}},{convKey:'private:90002'},{isGroup:true,convKey:'group:60001'},{text:'1,2'},{text:'同意'}]) await w.engine.handleMessage(evt(quote,bad));
  assert.equal((await w.engine.query(r.taskId,c)).status,'pending');assert.equal(w.requests,0);
  await Promise.all(Array.from({length:10},()=>w.engine.handleMessage(evt(quote))));await w.engine.idle();
  assert.equal(w.requests,1);assert.equal(w.delivered.length,1);assert.equal(w.delivered[0].convKey,c.convKey);
  const q=await w.engine.query(r.taskId,c);assert.equal(q.status,'delivered');assert.ok(q.images[0].handle);assert.equal(JSON.stringify(q).includes('iVBOR'),false);
  const disk=JSON.parse(await fs.readFile(path.join(w.dir,'tasks.json'),'utf8'));const task=disk.tasks[0];
  assert.equal(task.approvals[0].messageId,quote);assert.equal(task.snapshotHash,snapshotDigest(task.snapshot));assert.equal(JSON.stringify(disk).includes('local-test-key'),false);
});

test('拒绝和过期不计费，查询隔离，管理员仅本人私聊可跨任务管理',async(t)=>{
  let now=Date.now(); const w=await world(t,{now:()=>now,config:{...config,approvalTtlMs:1000}});
  const {r,c,quote}=await submit(w);await w.engine.handleMessage(evt(quote,{text:'2'}));
  assert.equal((await w.engine.query(r.taskId,c)).status,'rejected');
  assert.equal((await w.engine.query(r.taskId,caller('10002'))).ok,false);
  assert.equal((await w.engine.query(r.taskId,caller('10001','group:60002'))).ok,false);
  assert.equal((await w.engine.query(r.taskId,caller('90001','group:60002'))).ok,false);
  assert.equal((await w.engine.query(r.taskId,caller('90001','private:90001'))).ok,true);
  const b=await submit(w,caller('10002'));now+=1001;await approve(w,b.quote);
  assert.equal((await w.engine.query(b.r.taskId,b.c)).status,'expired');assert.equal(w.requests,0);
});

test('多人并发审批受worker并发上限约束，参数快照固定且调用去重',async(t)=>{
  let active=0,maxActive=0,requests=0;const captures=[];
  const w=await world(t,{config:{...config,concurrency:2},generate:async(input)=>{requests++;active++;maxActive=Math.max(maxActive,active);captures.push(input.snapshot);await new Promise((r)=>setTimeout(r,15));active--;return image();}});
  const submissions=await Promise.all(Array.from({length:6},(_,i)=>submit(w,caller(String(10001+i)))));
  const dupe=await w.engine.submit({prompt:'改变提示词'},submissions[0].c);assert.equal(dupe.taskId,submissions[0].r.taskId);
  w.engine.cfg.model='changed-after-submit';
  await Promise.all(submissions.map((s)=>w.engine.handleMessage(evt(s.quote))));await w.engine.idle();
  assert.equal(requests,6);assert.equal(maxActive,2);assert.ok(captures.every((x)=>x.model==='mock-image' && x.prompt==='雪地里的小猫'));
  assert.ok(w.delivered.every((d)=>d.convKey==='group:60001'));
});

test('pending/queued取消不调用接口，generating取消标结果不明且不投递',async(t)=>{
  let entered,release;const start=new Promise((r)=>entered=r);const wait=new Promise((r)=>release=r);let calls=0;
  const w=await world(t,{generate:async()=>{calls++;entered();await wait;return image();}});
  const a=await submit(w);await w.engine.cancel(a.r.taskId,a.c);await approve(w,a.quote);assert.equal(calls,0);
  const b=await submit(w,caller('10002'));await w.engine.handleMessage(evt(b.quote));await start;
  const queued=await submit(w,caller('10003'));await w.engine.handleMessage(evt(queued.quote));await w.engine.cancel(queued.r.taskId,queued.c);
  const result=await w.engine.cancel(b.r.taskId,b.c);assert.equal(result.status,'outcome_unknown');release();await w.engine.idle();assert.equal(w.delivered.length,0);assert.equal(calls,1);
});

test('投递失败只重投已存图片，跳过已经成功发送的那张，句柄查询可重新注册',async(t)=>{
  let sends=0;const w=await world(t,{config:{...config,count:2},generate:async()=>[...image(),...image()],deliverMedia:async()=>{sends++;return sends===2?{ok:false,code:'MOCK_DENIED'}:{ok:true,messageId:sends,handle:'h'+sends};}});
  const {r,c,quote}=await submit(w);await approve(w,quote);assert.equal(sends,2);
  assert.equal((await w.engine.query(r.taskId,c)).status,'delivery_failed');
  let registrations=0;const q=await w.engine.query(r.taskId,c,{registerMedia:async()=>({ok:true,handle:'fresh-'+ ++registrations})});assert.equal(q.images[1].handle,'fresh-2');
  await w.engine.retryDelivery(r.taskId,c);await w.engine.idle();assert.equal(sends,3);assert.equal((await w.engine.query(r.taskId,c)).status,'delivered');
  const files=await fs.readdir(path.join(w.dir,'images'));assert.equal(files.length,2);
});

test('明确4xx失败与超时结果不明分开，两者均不自动重新生成',async(t)=>{
  let calls=0;const w=await world(t,{generate:async()=>{calls++;throw Object.assign(new Error('secret-provider-output'),{code:'UPSTREAM_HTTP_ERROR',outcomeUnknown:calls!==1});}});
  const a=await submit(w);await approve(w,a.quote);assert.equal((await w.engine.query(a.r.taskId,a.c)).status,'failed');
  const b=await submit(w,caller('10002'));await approve(w,b.quote);assert.equal((await w.engine.query(b.r.taskId,b.c)).status,'outcome_unknown');
  for(let i=0;i<3;i++) await w.engine.maintenance();assert.equal(calls,2);assert.equal(w.delivered.length,0);
  assert.equal((await fs.readFile(path.join(w.dir,'tasks.json'),'utf8')).includes('secret-provider-output'),false);
});

test('重启不重放generating，恢复queued/pending，delivering仅人工重投，插件停用阻断审批和worker',async(t)=>{
  const w=await world(t);const a=await submit(w);const b=await submit(w,caller('10002'));const c=await submit(w,caller('10003'));const d=await submit(w,caller('10004'));
  // 磁盘种下崩溃时刻；没有走优雅dispose（它本来会取消待生成任务）。
  w.engine.active=false;clearInterval(w.engine.timer);await w.engine.idle();
  await w.engine.tx((db)=>{
    const generating=db.tasks.find((x)=>x.id===a.r.taskId);generating.state='generating';generating.decision={admin:'90001',quote:a.quote};
    const queued=db.tasks.find((x)=>x.id===b.r.taskId);queued.state='queued';queued.decision={admin:'90001',quote:b.quote};
    const x=db.tasks.find((x)=>x.id===c.r.taskId);x.state='delivering';x.generationSucceeded=true;x.images=[{path:`images/${x.id.slice(4)}-0.png`,mime:'image/png',bytes:PNG.length}];
  });
  await fs.writeFile(path.join(w.dir,`images/${c.r.taskId.slice(4)}-0.png`),PNG);await w.engine.releaseLock();
  let requests=0,sends=0;const reboot=new ImageTasks({dataDir:w.dir,config,apiKey:'local-test-key',sendText:async()=>({ok:true,messageId:-9}),generate:async()=>{requests++;return image();},deliverMedia:async()=>{sends++;return {ok:true,messageId:99};}});
  await reboot.init();await reboot.idle();
  t.after(async()=>{await reboot.dispose();await reboot.idle();await reboot.releaseLock();});
  assert.equal((await reboot.query(a.r.taskId,a.c)).status,'outcome_unknown');assert.equal(requests,1);assert.equal(sends,1);
  assert.equal((await reboot.query(c.r.taskId,c.c)).status,'delivery_failed');assert.equal((await reboot.query(d.r.taskId,d.c)).status,'pending');
  await reboot.retryDelivery(c.r.taskId,c.c);await reboot.idle();assert.equal(sends,2);assert.equal(requests,1);
  await reboot.dispose();await reboot.handleMessage(evt(d.quote));assert.equal((await reboot.query(d.r.taskId,d.c)).status,'cancelled');
  await reboot.idle();await reboot.releaseLock();
});

test('持久化限额、单实例锁、取消后的磁盘计量与终态清理',async(t)=>{
  let now=Date.now();const w=await world(t,{now:()=>now,config:{...config,requestsPerHour:1,retentionDays:1}});const a=await submit(w);
  assert.equal((await w.engine.submit({prompt:'第二个'},caller('10002'))).code,'IMAGE_LIMIT');
  const second=new ImageTasks({dataDir:w.dir,config,apiKey:'test',sendText:async()=>({ok:true}),deliverMedia:async()=>({ok:true})});
  await assert.rejects(second.init(),/占用/);
  await approve(w,a.quote);now+=86400001;await w.engine.cleanup();assert.equal(w.engine.db.tasks.length,0);assert.equal((await fs.readdir(path.join(w.dir,'images'))).length,0);
});

test('完整本地HTTP生图→审批→受控媒体队列→QQ模拟适配，投递重试不重发POST',async(t)=>{
  let posts=0,sends=0,permit=false;
  const server=http.createServer(async(req,res)=>{assert.equal(req.url,'/v1/images/generations');assert.equal(permit,true,'审批完成前不能请求');posts++;let text='';for await(const c of req)text+=c;assert.equal(JSON.parse(text).model,'mock-image');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{b64_json:PNG.toString('base64')}]}));});
  await new Promise((r)=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise((r)=>server.close(r)));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ling-img-e2e-'));const sequencer=createSequencer();
  const chat=createChatFactory({readMessages:()=>({ok:true,messages:[]}),lookupMessage:()=>({ok:false}),sendSegments:async()=>({ok:true})});
  const deliver=createMediaDelivery({media:chat.media,sequencer,sendSegments:async({convKey,segments})=>{assert.equal(convKey,'group:60001');assert.equal(segments[0].type,'image');assert.deepEqual(await fs.readFile(segments[0].data.file),PNG);sends++;return sends===1?{ok:false,code:'MOCK_GATE'}:{ok:true,messageId:919};}});
  const cards=[];const engine=new ImageTasks({dataDir:root,config:{...config,apiUrl:`http://127.0.0.1:${server.address().port}/v1`},apiKey:'local-test-key',sendText:async(key,text)=>{cards.push({key,text});return {ok:true,messageId:-44};},deliverMedia:(input)=>deliver({...input,pluginId:'image-generation',dataDir:root,isActive:()=>engine.active})});
  await engine.init();t.after(async()=>{await engine.dispose();await engine.idle();await engine.releaseLock();await fs.rm(root,{recursive:true,force:true});});
  const c=caller();const task=await engine.submit({prompt:'雪地里的小猫'},c);assert.equal(task.status,'pending');await engine.idle();assert.equal(posts,0);assert.equal(cards[0].key,'private:90001');
  permit=true;await engine.handleMessage(evt(-44));await engine.idle();assert.equal(posts,1);assert.equal((await engine.query(task.taskId,c)).status,'delivery_failed');
  await engine.retryDelivery(task.taskId,c);await engine.idle();assert.equal(posts,1);assert.equal(sends,2);assert.equal((await engine.query(task.taskId,c)).status,'delivered');
});
