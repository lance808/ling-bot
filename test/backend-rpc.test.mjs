import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Evaluate the production dispatcher with injected stores, persistence and plugin lifecycle.
// No application boot, user configuration, sockets or external requests are involved.
async function dispatcher(overrides = {}) {
 const source = await fs.readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
 const code = source.slice(source.indexOf('const rpc = {'), source.indexOf('/** 界面可见的配置')) + '\nrpc;';
 const events = [], config = { dsh:{enabled:false,token:'fictional-token'}, llm:{apiKey:''}, plugins:{enabled:[],allowDangerous:false,config:{}} };
 const context = { config, paths:{configPath:'fictional-config'}, writeJsonAtomic:async (_,c)=>events.push(['persist',c]), plugins:null, sendText:()=>{},log:{info:()=>{},warn:()=>{},error:()=>{}},
   // 真实实现里的私有辅助函数（在切片范围之外），这里按同样语义提供
   isPluginId:(id)=>/^[a-z][a-z0-9-]{1,40}$/.test(String(id??'')),
   persistConfig:async()=>{}, reloadPlugins:async()=>events.push(['reload']),
   usageLedger:{range:async q=>({...q,calls:620})},thinkingStore:{view:q=>({query:q,total:9})},personaStore:{setDefault:async id=>({ok:true,defaultId:id})},roleStore:{setDefault:async id=>({ok:true,defaultId:id})}, ...overrides };
 const rpc=vm.runInNewContext(code,context); return {rpc,events,context};
}
test('production RPC query/default branches match frontend contract',async()=>{
 const {rpc}=await dispatcher();const u=await rpc.handle('action',{name:'usage.query',params:{since:1,until:2}});assert.equal(u.ok,true);assert.equal(u.range.calls,620);
 const th=await rpc.handle('action',{name:'thinking.query',params:{convKey:'group:10000'}});assert.equal(th.query.convKey,'group:10000');
 assert.equal((await rpc.handle('action',{name:'persona.setDefault',params:{id:'fake'}})).defaultId,'fake');assert.equal((await rpc.handle('action',{name:'role.setDefault',params:{id:'fake-role'}})).defaultId,'fake-role');
});

/*
 * 旧的 `dsh.config` 设置通道现在只是**迁移垫片**：DSH 是普通插件，
 * 真正的配置走 `plugin.saveConfig`。这条测试守的是"垫片确实委托给管理器"，
 * 而不是自己去改 config.dsh —— 否则老界面能存进去、新插件读不到。
 */
test('legacy dsh.config delegates to the plugin manager instead of writing config.dsh',async()=>{
 const calls=[];
 const fakePlugins={
  enable:async(id)=>calls.push(['enable',id]),
  disable:async(id)=>calls.push(['disable',id]),
  saveConfig:async(id,input)=>{calls.push(['saveConfig',id,input]);return {ok:true,applied:true,restartRequired:false,message:'ok'};},
 };
 const {rpc,events}=await dispatcher({plugins:fakePlugins});
 const value={enabled:true,port:3458,token:'secret-token',admins:['12345','67890'],sessionId:'fictional'};
 const r=await rpc.handle('setting',{key:'dsh.config',value});
 assert.equal(r.ok,true);
 // 顺序：先启用插件，再存配置（否则保存时插件没跑起来，配置不生效）
 assert.deepEqual(calls[0],['enable','dsh-bridge']);
 assert.equal(calls[1][0],'saveConfig');
 assert.equal(calls[1][1],'dsh-bridge');
 // 数组在插件清单里是逗号分隔文本（配置类型只有 text，没有 array）
 assert.equal(calls[1][2].config.admins,'12345,67890');
 assert.equal(calls[1][2].config.port,3458);
 assert.equal(calls[1][2].config.sessionId,'fictional');
 // 令牌必须走 secrets，绝不能进普通配置
 assert.equal(calls[1][2].secrets.token,'secret-token');
 assert.equal('token' in calls[1][2].config,false);
 // 不再往 config.dsh 里写
 assert.deepEqual(events,[]);
});

test('legacy dsh.config 的启用开关映射成插件启停',async()=>{
 const calls=[];
 const fakePlugins={
  enable:async(id)=>calls.push(['enable',id]),
  disable:async(id)=>calls.push(['disable',id]),
  saveConfig:async()=>calls.push(['saveConfig'])||{ok:true,applied:true,message:'ok'},
 };
 const {rpc}=await dispatcher({plugins:fakePlugins});
 await rpc.handle('setting',{key:'dsh.config',value:{enabled:false,port:3458,admins:['12345'],sessionId:''}});
 assert.ok(calls.some((c)=>c[0]==='disable'),'enabled:false 必须停用插件');
});

test('plugin.* 动作拒绝非法 id（会被拼进磁盘路径）',async()=>{
 const calls=[];
 const fakePlugins={
  enable:async()=>{calls.push('enable');return {ok:true,status:'ready'};},disable:async()=>calls.push('disable'),
  saveConfig:async()=>calls.push('save'),test:async()=>calls.push('test'),
  reload:async()=>calls.push('reload'),rescan:async()=>calls.push('rescan'),install:async()=>calls.push('install'),
 };
 const {rpc}=await dispatcher({plugins:fakePlugins});
 for(const bad of ['../evil','a/b','A-Bad','', 'x'.repeat(60)]){
  const r=await rpc.handle('action',{name:'plugin.enable',params:{id:bad}});
  assert.equal(r.ok,false,`${bad} 不该被接受`);
 }
 assert.deepEqual(calls,[],'拒绝时一次都不该落到管理器');
 const ok=await rpc.handle('action',{name:'plugin.enable',params:{id:'dsh-bridge'}});
 assert.equal(ok.ok,true);
 assert.deepEqual(calls,['enable']);
});

test('plugin.install 只接受本机路径，不接受 URL',async()=>{
 const calls=[];
 const fakePlugins={install:async(p)=>{calls.push(p);return {ok:true,id:'demo'};}};
 const {rpc}=await dispatcher({plugins:fakePlugins});
 const noPath=await rpc.handle('action',{name:'plugin.install',params:{}});
 assert.equal(noPath.ok,false);
 assert.deepEqual(calls,[]);
 const r=await rpc.handle('action',{name:'plugin.install',params:{path:'D:/pkg/demo'}});
 assert.equal(r.ok,true);
 assert.deepEqual(calls,['D:/pkg/demo']);
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
