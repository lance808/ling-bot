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
