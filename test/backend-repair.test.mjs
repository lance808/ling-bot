import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageLedger } from '../src/llm/usage.mjs';
import { normalizeUsage } from '../src/llm/client.mjs';
import { ThinkingStore } from '../src/llm/thinking.mjs';
import { PersonaStore } from '../src/llm/persona.mjs';
import { normalizeDsh } from '../src/config/dsh.mjs';
import { clearApiKey } from '../src/config/credentials.mjs';
import { probeVision, probeImageGen, judgeVisionAnswer, endpointKey, endpointCapabilities } from '../src/llm/capability.mjs';

async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-backend-')); t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); }); return dir; }
test('complete journal ranges exceed both recent limits and preserve cache coverage', async t => {
 const dir = await temp(t), filePath = path.join(dir, 'usage.jsonl'), at = Date.now();
 await fs.writeFile(filePath, Array.from({length: 620}, (_, i) => JSON.stringify({at: at-i, promptTokens: 10, completionTokens: 2,totalTokens:12,...(i%2 ? {cachedTokens:0}: {})})).join('\n'));
 const l = new UsageLedger({filePath}); await l.load(); const r = await l.range({since:at-1000,until:at});
 assert.equal(r.calls,620); assert.equal(r.totalTokens,7440); assert.equal(r.cacheReported,310); assert.equal(r.cachePromptTokens,3100); assert.equal(r.covered,true); assert.equal(l.summary().recent.length,50);
 await fs.appendFile(filePath,'\nbroken\n'); assert.equal((await l.range()).covered,false);
 assert.equal(normalizeUsage({prompt_tokens:10,prompt_tokens_details:{cached_tokens:0}}).cachedTokens,0);
 assert.equal('cachedTokens' in normalizeUsage({prompt_tokens:10}),false);
});
test('thinking filters before limits and same-day cursor does not lose records', async t => {
 const dir = await temp(t), now = Date.now(); const s = new ThinkingStore({dir,now:()=>now});
 for(let i=0;i<65;i++) s.record({convKey:'group:10000',at:now+i,steps:[{reasoning:'fictional'}]});
 for(let i=0;i<80;i++) s.record({convKey:'group:20000',at:now+100+i,steps:[{reasoning:'fictional'}]});
 const a=s.view({convKey:'group:10000',limit:50}); assert.equal(a.entryCount,50);assert.equal(a.stepCount,50);assert.equal(a.total,65); assert.equal(a.hasMore,true);
 s.record({convKey:'group:10000',at:now+500,steps:[{reasoning:'new fictional record'}]});
 const b=s.view({convKey:'group:10000',limit:50,before:a.nextBefore});assert.equal(b.entryCount,15);assert.equal(b.hasMore,false);assert.ok(b.days[0].entries.at(-1).at<a.days[0].entries[0].at); await s.flush();
});
test('global default is independent from editing and survives reload',async t=>{
 const dir=await temp(t),filePath=path.join(dir,'persona.json'),s=new PersonaStore({filePath});
 const a=await s.create('a','alpha'),b=await s.create('b','beta'); await s.activate(b.card.id); assert.equal(s.resolveFor('group:12345').id,a.card.id);
 await s.setDefault(b.card.id); await s.activate(a.card.id); const re=new PersonaStore({filePath});await re.load();assert.equal(re.resolveFor('group:12345').id,b.card.id);assert.equal(re.view().activeId,a.card.id);
});
test('DSH transaction validates whole object and preserves masked empty token',()=>{
 const prev={token:'fictional-token'}, value={enabled:true,port:3458,token:'',admins:['12345'],sessionId:'fake-session'};
 assert.equal(normalizeDsh(value,prev).token,'fictional-token');assert.throws(()=>normalizeDsh({...value,port:0},prev)); assert.throws(()=>normalizeDsh({...value,admins:[]},prev));assert.equal(prev.token,'fictional-token');
});
test('credential deletion errors and environment source never report cleared success',async()=>{
 const config={llm:{apiKey:'fictional-value'}}, calls=[];
 const fail=await clearApiKey({config,vaultPath:'fictional',unlink:async()=>{throw Object.assign(new Error(),{code:'EACCES'});},persist:async()=>calls.push(1)});assert.equal(fail.ok,false);assert.equal(calls.length,0);
 const env=await clearApiKey({config,vaultPath:'fictional',unlink:async()=>{},persist:async c=>calls.push(c),envKey:'fictional-env'});assert.equal(env.ok,false);assert.equal(env.source,'env');assert.equal(env.config.llm.apiKey,'');assert.equal(config.llm.apiKey,'fictional-value');
});
test('probes use mocked fetch: service failures unknown, text/empty images no success, endpoint isolated',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 for(const status of [401,403,429,500]){globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'unsupported request'}}),{status});assert.equal((await probeVision({baseUrl:'https://fake.invalid',apiKey:'fictional',model:'fake'})).supported,null);assert.equal((await probeImageGen({baseUrl:'https://fake.invalid',apiKey:'fictional',model:'fake'})).supported,null);}
 assert.equal(judgeVisionAnswer({choices:[{message:{content:'hello'}}]}).supported,null);assert.equal(judgeVisionAnswer({choices:[{message:{content:'红色'}}]}).supported,true);
 globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{images:[],content:[{type:'text',text:'fake'}]}}]}),{status:200});assert.notEqual((await probeImageGen({baseUrl:'https://fake.invalid',apiKey:'fictional',model:'fake'})).supported,true);
 const all={[endpointKey('https://a.invalid')]:{fake:{vision:true}}};assert.deepEqual(endpointCapabilities(all,'https://b.invalid'),{});assert.equal(endpointKey('https://a.invalid/v1/'),endpointKey('https://a.invalid'));
});
