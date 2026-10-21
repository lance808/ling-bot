import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeDsh } from '../src/config/dsh.mjs';

// Evaluate the production dispatcher with injected stores, persistence and plugin lifecycle.
// No application boot, user configuration, sockets or external requests are involved.
async function dispatcher(overrides = {}) {
 const source = await fs.readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
 const code = source.slice(source.indexOf('const rpc = {'), source.indexOf('/** 界面可见的配置')) + '\nrpc;';
 const events = [], config = { dsh:{enabled:false,token:'fictional-token'}, llm:{apiKey:''} };
 const context = { normalizeDsh, config, paths:{configPath:'fictional-config'}, writeJsonAtomic:async (_,c)=>events.push(['persist',c.dsh]), pluginMods:[], sendText:()=>{},log:{info:()=>{}}, usageLedger:{range:async q=>({...q,calls:620})},thinkingStore:{view:q=>({query:q,total:9})},personaStore:{setDefault:async id=>({ok:true,defaultId:id})},roleStore:{setDefault:async id=>({ok:true,defaultId:id})}, ...overrides };
 const rpc=vm.runInNewContext(code,context); return {rpc,events,context};
}
test('production RPC query/default branches match frontend contract',async()=>{
 const {rpc}=await dispatcher();const u=await rpc.handle('action',{name:'usage.query',params:{since:1,until:2}});assert.equal(u.ok,true);assert.equal(u.range.calls,620);
 const th=await rpc.handle('action',{name:'thinking.query',params:{convKey:'group:10000'}});assert.equal(th.query.convKey,'group:10000');
 assert.equal((await rpc.handle('action',{name:'persona.setDefault',params:{id:'fake'}})).defaultId,'fake');assert.equal((await rpc.handle('action',{name:'role.setDefault',params:{id:'fake-role'}})).defaultId,'fake-role');
});
test('DSH validation rejects before persistence; runtime stop/start follows persisted transaction',async()=>{
 const order=[];const mod={stopBridge:async()=>order.push('stop'),startBridge:async()=>{order.push('start');return {ok:true};}};
 const {rpc,context}=await dispatcher({pluginMods:[{name:'dsh-bridge',mod}],writeJsonAtomic:async()=>order.push('persist')});
 const value={enabled:true,port:3458,token:'',admins:['12345'],sessionId:'fictional'};
 assert.equal((await rpc.handle('setting',{key:'dsh.config',value:{...value,port:-1}})).ok,false);assert.equal(order.length,0);
 const r=await rpc.handle('setting',{key:'dsh.config',value});assert.equal(r.applied,true);assert.deepEqual(order,['persist','stop','start']);assert.equal(context.config.dsh.token,'fictional-token');
 mod.startBridge=async()=>({ok:false});const failed=await rpc.handle('setting',{key:'dsh.config',value});assert.equal(failed.ok,true);assert.equal(failed.applied,false);assert.equal(failed.restartRequired,true);
});

/* -------------------------------------------------- 思考链路：删除与容错 */

test('thinking.clear 必须给出明确日期，绝不默认为"今天"',async()=>{
 // clearDay() 的默认值是今天：界面传个空值过来就会静默删掉今天的记录。
 // 所以这一层必须自己把关，不让空/畸形日期流到 store。
 const cleared=[];const {rpc}=await dispatcher({thinkingStore:{view:()=>({days:[],total:0}),clearDay:async d=>{cleared.push(d);return {date:d,removed:2};}}});
 for (const bad of [undefined,{}, {date:''}, {date:'   '}, {date:'2026-13-45'}, {date:'今天'}]) {
   const r=await rpc.handle('action',{name:'thinking.clear',params:bad});
   assert.equal(r.ok,false,`${JSON.stringify(bad)} 不该被接受`);
   assert.match(r.message,/YYYY-MM-DD/);
 }
 assert.deepEqual(cleared,[],'拒绝时一次都不该落到 store');
 const ok=await rpc.handle('action',{name:'thinking.clear',params:{date:' 2026-10-19 '}});
 assert.equal(ok.ok,true);assert.equal(ok.removed,2);
 assert.deepEqual(cleared,['2026-10-19'],'日期要 trim 之后再交给 store');
});

test('思考视图算不出来时降级成空视图，不许让整个 RPC 抛错',async()=>{
 // 这条守的是"新思考链路拉取失败"：view() 一旦抛错，
 // 以前整个 snapshot 就 reject，用户连消息列表都看不到。
 const {rpc}=await dispatcher({thinkingStore:{view:()=>{throw new Error('磁盘炸了');}}});
 const v=rpc.thinkingView({days:1});
 // vm 里返回的数组是另一个 realm 的，deepEqual 会因为原型不同而失败；
 // 走一趟 JSON 才能在宿主 realm 里比较结构。
 const plain=JSON.parse(JSON.stringify(v));
 assert.deepEqual(plain.days,[]);
 assert.equal(plain.total,0);
 assert.match(plain.lastError,/计算失败/);
 // 形状必须和正常视图一致，否则界面每个渲染点都要写判空
 assert.deepEqual(plain.conversations,[]);
 assert.deepEqual(plain.dayKeys,[]);
 assert.equal(plain.hasMore,false);
 assert.equal(typeof plain.retentionDays,'number');
});
