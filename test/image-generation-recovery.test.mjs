import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ImageTasks } from '../plugins/image-generation/lib/tasks.mjs';
const cfg={apiUrl:'http://127.0.0.1:1/v1',model:'test',admins:'90001',requestsPerHour:100,imagesPerDay:100,maxPerRequester:10};
const c=(id='10001')=>({convKey:'group:60001',origin:'group',requester:{id},callId:Math.random().toString()});
const event=(id,admin='90001',text='1')=>({convKey:`private:${admin}`,sender:{userId:admin},replyTo:{messageId:id},text});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const images=()=>[{buffer:png,mime:'image/png',extension:'png'}];
async function make(t,extras={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ling-img-recovery-'));const cards=[];let calls=0;
 const engine=new ImageTasks({dataDir:dir,config:cfg,apiKey:'local-test-key',sendText:async(key,text)=>{const r={key,text,id:-cards.length-1};cards.push(r);return {ok:true,messageId:r.id};},generate:async()=>{calls++;return images();},deliverMedia:async()=>({ok:true,messageId:99,handle:'mock'}),...extras});
 await engine.init();t.after(async()=>{await engine.dispose();await engine.idle();await engine.releaseLock();await fs.rm(dir,{recursive:true,force:true});});return {dir,engine,cards,get calls(){return calls;}};
}
async function submit(w,who=c()) {const task=await w.engine.submit({prompt:'local-test'},who);for(let n=0;n<300&&!w.engine.db.tasks[0]?.approvals.length;n++)await new Promise(r=>setTimeout(r,2));return {task,who};}

test('未知请求者即使知道正在生成的taskId也不能取消worker',async(t)=>{
 let entered,release,signal;const started=new Promise(r=>entered=r);const wait=new Promise(r=>release=r);
 const w=await make(t,{generate:async(input)=>{signal=input.signal;entered();await wait;return images();}});
 const {task,who}=await submit(w);await w.engine.handleMessage(event(w.cards[0].id));await started;
 const denied=await w.engine.cancel(task.taskId,c('10002'));assert.equal(denied.ok,false);assert.equal(signal.aborted,false);
 release();await w.engine.idle();assert.equal((await w.engine.query(task.taskId,who)).status,'delivered');
});

test('多管理员同时引用各自卡片，第一条有效决定胜出且恰好生成一次',async(t)=>{
 const w=await make(t,{config:{...cfg,admins:'90001,90002'}});const {task,who}=await submit(w);await w.engine.idle();assert.equal(w.cards.length,2);
 await Promise.all([w.engine.handleMessage(event(w.cards[0].id)),w.engine.handleMessage(event(w.cards[1].id,'90002','2'))]);await w.engine.idle();
 assert.equal(w.calls,1);assert.equal((await w.engine.query(task.taskId,who)).status,'delivered');
});

test('审核卡发送失败或缺少有效messageId时停止，绝不计费',async(t)=>{
 for(const response of [{ok:false,code:'DENIED'},{ok:true},{ok:true,messageId:0}]){
  const w=await make(t,{sendText:async()=>response});const r=await w.engine.submit({prompt:'test'},c());await w.engine.idle();assert.equal(w.engine.db.tasks[0].state,'failed');assert.equal(w.calls,0);assert.equal(r.status,'pending');
 }
});

test('自动投递重试有上限，尝试用尽后保留图片，绝不重新生成',async(t)=>{
 let sends=0,now=Date.now();const w=await make(t,{config:{...cfg,deliveryAttempts:2,deliveryRetryMs:100},now:()=>now,deliverMedia:async()=>{sends++;return {ok:false,code:'MOCK_GATE'};}});
 await submit(w);await w.engine.handleMessage(event(w.cards[0].id));await w.engine.idle();assert.equal(sends,1);
 now+=101;await w.engine.maintenance();await w.engine.idle();assert.equal(sends,2);
 now+=101;await w.engine.maintenance();await w.engine.idle();assert.equal(sends,2);assert.equal(w.calls,1);assert.equal(w.engine.db.tasks[0].state,'delivery_failed');
});

test('停用打断在途收费请求，保存结果不明，不会随后投递',async(t)=>{
 let entered,release,aborted=false,sends=0;const started=new Promise(r=>entered=r);const wait=new Promise(r=>release=r);
 const w=await make(t,{generate:async({signal})=>{signal.addEventListener('abort',()=>aborted=true);entered();await wait;return images();},deliverMedia:async()=>{sends++;return {ok:true};}});
 const {task,who}=await submit(w);await w.engine.handleMessage(event(w.cards[0].id));await started;
 await w.engine.dispose();assert.equal(aborted,true);release();await w.engine.idle();assert.equal(sends,0);assert.equal((await w.engine.query(task.taskId,who)).status,'outcome_unknown');
});

test('API地址改变使重启前的pending失效，保留旧快照且不能用新Key请求旧端点',async(t)=>{
 const w=await make(t);const {task,who}=await submit(w);await w.engine.idle();
 w.engine.active=false;clearInterval(w.engine.timer);await w.engine.releaseLock();
 const reboot=new ImageTasks({dataDir:w.dir,config:{...cfg,apiUrl:'http://127.0.0.1:2/v1'},apiKey:'new-local-test-key',sendText:async()=>({ok:true}),generate:async()=>{throw new Error('must not POST');},deliverMedia:async()=>({ok:true})});
 await reboot.init();assert.equal((await reboot.query(task.taskId,who)).status,'cancelled');await reboot.handleMessage(event(w.cards[0].id));await reboot.idle();assert.equal((await reboot.query(task.taskId,who)).status,'cancelled');
 await reboot.dispose();await reboot.releaseLock();
});

test('重复初始化目录被锁，恢复可疑状态无审批凭据时失败关闭',async(t)=>{
 const w=await make(t);const {task}=await submit(w);await w.engine.idle();w.engine.active=false;clearInterval(w.engine.timer);
 await w.engine.tx(db=>{db.tasks[0].state='queued';});await w.engine.releaseLock();
 const reboot=new ImageTasks({dataDir:w.dir,config:cfg,apiKey:'test',generate:async()=>{assert.fail('must not POST');},sendText:async()=>({ok:true}),deliverMedia:async()=>({ok:true})});
 await assert.rejects(reboot.init(),/审批凭据/);await reboot.dispose();await reboot.releaseLock();assert.ok(task.taskId);
});

test('初始化中止不启动恢复worker，并行释放锁幂等，插件包复制后可独立加载',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ling-img-init-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const engine=new ImageTasks({dataDir:path.join(root,'data'),config:cfg,apiKey:'test',sendText:async()=>{assert.fail('must not send');},generate:async()=>{assert.fail('must not POST');},deliverMedia:async()=>({ok:true})});
 const initializing=engine.init();const stop=engine.dispose();await initializing;await stop;assert.equal(engine.active,false);assert.equal(engine.timer,null);
 await Promise.all([engine.releaseLock(),engine.releaseLock()]);assert.equal((await fs.readdir(path.join(root,'data'))).includes('worker.lock'),false);
 const source=new URL('../plugins/image-generation/',import.meta.url);const target=path.join(root,'standalone');await fs.cp(source,target,{recursive:true});
 const plugin=(await import(pathToFileURL(path.join(target,'index.mjs')))).default;assert.equal(typeof plugin.init,'function');assert.equal(typeof plugin.callTool,'function');
});

test('旧投递失败与显式重投并发时清理事务重新校验，不能删除已排队重投的文件',async(t)=>{
 let now=Date.now(),sends=0;const w=await make(t,{now:()=>now,config:{...cfg,retentionDays:1},deliverMedia:async()=>{sends++;return sends===1?{ok:false,code:'MOCK'}:{ok:true,messageId:99};}});
 const {task,who}=await submit(w);await w.engine.handleMessage(event(w.cards[0].id));await w.engine.idle();now+=86400001;
 const retry=w.engine.retryDelivery(task.taskId,who);const cleanup=w.engine.cleanup();await Promise.all([retry,cleanup]);await w.engine.idle();
 assert.equal((await w.engine.query(task.taskId,who)).status,'delivered');assert.equal(sends,2);assert.equal(w.engine.fault,false);
});
