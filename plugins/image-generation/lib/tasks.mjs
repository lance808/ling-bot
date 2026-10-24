import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeConfig, parameterSnapshot, snapshotDigest } from './config.mjs';
import { generateImages } from './generate.mjs';

const TERMINAL = new Set(['delivered', 'rejected', 'expired', 'failed', 'cancelled', 'outcome_unknown']);
const RESERVING = new Set(['pending', 'queued', 'generating']);
const validId = (v) => /^-?[1-9]\d*$/.test(String(v ?? ''));
const copy = (v) => structuredClone(v);
const errorView = (code, message) => ({ code, message });

/** 单实例串行事务：只有原子文件提交成功后才发布新内存状态。付费/发送前必须先落盘。 */
export class ImageTasks {
  constructor({ dataDir, config, apiKey, sendText, deliverMedia, generate = generateImages, now = Date.now }) {
    this.dir = path.resolve(dataDir); this.cfg = normalizeConfig(config); this.apiKey = apiKey;
    this.sendText = sendText; this.deliverMedia = deliverMedia; this.generate = generate; this.now = now;
    this.db = { version: 1, tasks: [] }; this.chain = Promise.resolve(); this.running = new Map();
    this.work = new Set(); this.active = true; this.timer = null; this.fault = false; this.diskBytes = 0;
  }
  init() {
    this.initializing=this.initialize(); return this.initializing;
  }
  async initialize() {
    if (!this.cfg.apiUrl || !this.cfg.model || !this.apiKey || !this.cfg.admins.length) throw new Error('请配置独立生图API地址、Key、模型和审核管理员');
    await fs.mkdir(this.dir, { recursive: true });
    this.dir = await fs.realpath(this.dir);
    // 同一dataDir只能一个worker。活进程持锁时拒绝第二个实例；崩溃遗留锁仅在PID已退出时回收。
    this.lockFile = path.join(this.dir, 'worker.lock'); this.lockToken = randomUUID();
    try {
      const f=await fs.open(this.lockFile,'wx'); try { await f.writeFile(JSON.stringify({pid:process.pid,token:this.lockToken})); } finally { await f.close(); }
    } catch(e) {
      if(e.code!=='EEXIST') throw e;
      // 回收动作本身也互斥，避免两个启动者都判断旧PID已死后互删新锁。
      const recoveryFile=path.join(this.dir,'worker-recovery.lock');
      const recovery=await fs.open(recoveryFile,'wx');
      try {
        const old=JSON.parse(await fs.readFile(this.lockFile,'utf8'));
        if(!Number.isSafeInteger(old.pid) || old.pid<1) throw new Error('任务目录锁不合法');
        let dead=false; try { process.kill(old.pid,0); } catch(err) { dead=err.code==='ESRCH'; }
        if(!dead) throw new Error('生图任务目录已被其他活跃实例占用');
        await fs.unlink(this.lockFile);
        const f=await fs.open(this.lockFile,'wx'); try { await f.writeFile(JSON.stringify({pid:process.pid,token:this.lockToken})); } finally { await f.close(); }
      } finally { await recovery.close(); await fs.unlink(recoveryFile); }
    }
    this.hasLock=true;
    this.file = path.join(this.dir, 'tasks.json');
    this.imagesDir = path.join(this.dir, 'images');
    await fs.mkdir(this.imagesDir, { recursive: true });
    if (await fs.realpath(this.imagesDir) !== this.imagesDir) throw new Error('图片目录不允许符号链接');
    try {
      const st = await fs.lstat(this.file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024 * 1024) throw new Error('任务库文件不合法');
      this.db = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (this.db.version !== 1 || !Array.isArray(this.db.tasks)) throw new Error('任务库格式不受支持');
      const states=new Set([...TERMINAL,'pending','queued','generating','generated','delivering','delivery_failed']);
      for (const t of this.db.tasks) {
        if (!/^img_[a-f0-9-]{36}$/.test(t.id) || !states.has(t.state) || t.snapshotHash !== snapshotDigest(t.snapshot) || !Array.isArray(t.images) || !Array.isArray(t.approvals)) throw new Error('任务库快照校验失败');
        if(['queued','generating'].includes(t.state) && (!t.decision || !t.approvals.some((a)=>a.admin===t.decision.admin && a.messageId===t.decision.quote))) throw new Error('任务库缺少审批凭据');
        for (const i of t.images) if (!/^images\/[a-f0-9-]{36}-\d+\.(png|jpg|webp|gif)$/.test(i.path)) throw new Error('任务媒体路径不合法');
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await this.tx((db) => {
      for (const t of db.tasks) {
        if (t.state === 'generating') this.state(t, 'outcome_unknown', 'RESTART_UNKNOWN', '重启打断收费请求，禁止自动重发');
        else if (t.state === 'delivering') this.state(t, 'delivery_failed', 'DELIVERY_INTERRUPTED', '重启打断投递，可能已发送；请查询后显式重试投递');
        else if (t.state === 'pending' && t.expiresAt <= this.now()) this.state(t, 'expired');
        else if (['pending','queued'].includes(t.state) && t.snapshot.apiUrl !== this.cfg.apiUrl) this.state(t, 'cancelled', 'CONFIG_CHANGED', 'API地址变更，需要重新提交审批');
      }
    });
    await this.cleanup();
    if(!this.active) return;
    this.timer = setInterval(() => this.track(this.maintenance()), 1000); this.timer.unref();
    for(const t of this.db.tasks) if(t.state==='pending' && !t.notificationStarted) this.track(this.notify(t.id));
    this.kick();
  }
  tx(fn) {
    const p = this.chain.then(async () => {
      if (this.fault) throw new Error('任务存储故障，已停止新操作');
      const next = copy(this.db); const result = await fn(next);
      const tmp = path.join(this.dir, `.tasks-${randomUUID()}.tmp`);
      try {
        const f = await fs.open(tmp, 'wx');
        try { await f.writeFile(JSON.stringify(next)); await f.sync(); } finally { await f.close(); }
        await fs.rename(tmp, this.file); this.db = next;
      } catch (e) { this.fault = true; throw e; }
      return copy(result);
    });
    this.chain = p.catch(() => {}); return p;
  }
  state(t, state, code, message) {
    t.state = state; t.updatedAt = this.now();
    if (code) t.error = errorView(code, message);
    else t.error = null;
  }
  track(p) {
    const handled = Promise.resolve(p).catch(() => { this.fault = true; });
    this.work.add(handled); handled.finally(() => this.work.delete(handled)); return handled;
  }
  caller(c) {
    if (!c || !/^(group|private):[1-9]\d*$/.test(c.convKey) || !/^\d{4,15}$/.test(c.requester?.id ?? '') || c.origin === 'proactive') throw new Error('需要宿主提供的真实会话与请求者，主动回合不可生图');
    return { convKey: c.convKey, requester: { id: c.requester.id, nickname: String(c.requester.nickname ?? '').slice(0, 80) }, messageId: c.messageId ?? null, callId: String(c.callId ?? '') };
  }
  canAccess(t, c) {
    return this.cfg.admins.includes(String(c?.requester?.id)) && c?.convKey === `private:${c.requester.id}`
      || t.convKey === c?.convKey && t.requester.id === c?.requester?.id;
  }
  view(t) {
    if (!t) return { ok: false, code: 'IMAGE_TASK_NOT_FOUND', message: '任务不存在或不属于当前请求者' };
    return { ok: true, taskId: t.id, status: t.state, createdAt: t.createdAt, expiresAt: t.expiresAt,
      prompt: t.snapshot.prompt, model: t.snapshot.model, size: t.snapshot.size, count: t.snapshot.count,
      error: t.error, storageFault: this.fault, generationSucceeded: t.generationSucceeded === true,
      images: t.images.map((i) => ({ handle: i.handle || null, mime: i.mime, bytes: i.bytes, delivered: !!i.deliveredAt, messageId: i.messageId ?? null })),
      note: t.state === 'outcome_unknown' ? '可能已经计费，不会自动重新生成；请人工向服务商核实' : undefined };
  }
  async submit(args, caller, signal) {
    if (!this.active || signal?.aborted) return { ok: false, code: 'IMAGE_STOPPED', message: '插件或本次调用已取消' };
    const who = this.caller(caller); const snapshot = parameterSnapshot(this.cfg, args);
    const result = await this.tx(async (db) => {
      if (!this.active || signal?.aborted) throw new Error('提交已取消');
      const duplicate = who.callId && db.tasks.find((t) => t.callId === who.callId && t.convKey === who.convKey && t.requester.id === who.requester.id);
      if (duplicate) return this.view(duplicate);
      const now = this.now(); const live = db.tasks.filter((t) => !TERMINAL.has(t.state));
      const recent = db.tasks.filter((t) => t.createdAt > now - 3600000);
      const daily = db.tasks.filter((t) => t.createdAt > now - 86400000).reduce((n,t) => n + t.snapshot.count, 0);
      // 事务内重新计量磁盘，包含崩溃孤儿及取消后残留图；在途任务继续保留最大容量。
      let diskBytes=0;
      for(const e of await fs.readdir(this.imagesDir,{withFileTypes:true})) if(e.isFile()) diskBytes+=(await fs.stat(path.join(this.imagesDir,e.name))).size;
      const used = diskBytes + db.tasks.reduce((n,t) => n + (RESERVING.has(t.state) ? t.snapshot.count*t.snapshot.maxImageBytes : 0), 0);
      if (live.length >= this.cfg.maxPending || live.filter((t) => t.requester.id === who.requester.id).length >= this.cfg.maxPerRequester
        || recent.length >= this.cfg.requestsPerHour || daily + snapshot.count > this.cfg.imagesPerDay || db.tasks.length >= this.cfg.maxTasks
        || used + snapshot.count*snapshot.maxImageBytes > this.cfg.maxStorageBytes) return { ok: false, code: 'IMAGE_LIMIT', message: '任务、频率、每日张数或磁盘预留限额已达上限' };
      const t = { id: `img_${randomUUID()}`, ...who, snapshot, snapshotHash: snapshotDigest(snapshot), state: 'pending', createdAt: now, updatedAt: now,
        expiresAt: now + this.cfg.approvalTtlMs, approvals: [], images: [], generationSucceeded: false, deliveryAttempts: 0, nextDeliveryAt: 0, error: null };
      db.tasks.push(t); return this.view(t);
    });
    if (result.ok && !this.db.tasks.find((t) => t.id === result.taskId)?.approvals.length) this.track(this.notify(result.taskId));
    return result;
  }
  async notify(id) {
    // 同一提交只排一次审核通知，通知失败不重发，也绝不生成。
    const t = this.db.tasks.find((t) => t.id === id);
    if (!this.active || t?.state !== 'pending' || t.notificationStarted) return;
    const claimed = await this.tx((db) => { const x=db.tasks.find((v)=>v.id===id); if (x.notificationStarted || x.state !== 'pending') return false; x.notificationStarted=true; return true; });
    if (!claimed) return;
    const s = t.snapshot;
    const text = `【生图前审批】${id}\n来源：${t.convKey}\n请求者：${t.requester.id}\n模型：${s.model}\n尺寸：${s.size}\n张数：${s.count}\n提示词：\n${s.prompt}\n\n有效期至：${new Date(t.expiresAt).toISOString()}\n同意后才会请求收费接口，不再进行第二次看图审批。\n必须引用本条消息回复：1 同意，2 拒绝。`;
    for (const admin of this.cfg.admins) {
      if (!this.active || this.db.tasks.find((x)=>x.id===id)?.state !== 'pending') break;
      let r; try { r = await this.sendText(`private:${admin}`, text); } catch { r = { ok:false }; }
      await this.tx((db) => { const x=db.tasks.find((v)=>v.id===id); if (!x) return;
        if (r?.ok === true && validId(r.messageId)) x.approvals.push({ admin, convKey:`private:${admin}`, messageId:String(r.messageId), at:this.now() });
      });
    }
    await this.tx((db) => { const x=db.tasks.find((v)=>v.id===id); if (x?.state==='pending' && !x.approvals.length) this.state(x,'failed','APPROVAL_DELIVERY_FAILED','审核卡发送失败或未返回消息ID，未调用收费接口'); });
  }
  async handleMessage(evt) {
    const quote = String(evt?.replyTo?.messageId ?? '').trim();
    if (!quote) return false;
    const t = this.db.tasks.find((x) => x.approvals.some((a) => a.messageId === quote));
    if (!t) return false;
    const admin = String(evt?.sender?.userId ?? ''); const convKey = String(evt?.convKey ?? '');
    const a = t.approvals.find((x) => x.messageId === quote && x.admin === admin && x.convKey === convKey);
    if (evt?.isGroup || !a || !this.cfg.admins.includes(admin) || convKey !== `private:${admin}`) return true;
    const choice = String(evt.text ?? '').trim();
    let message;
    await this.tx((db) => {
      const x = db.tasks.find((v)=>v.id===t.id);
      if (!this.active || x.state !== 'pending') { message='该生图审批已处理或已失效'; return; }
      if (x.expiresAt <= this.now()) { this.state(x,'expired'); message='生图审批已过期'; return; }
      if (!['1','2'].includes(choice)) { message='请引用审核请求，回复 1 同意或 2 拒绝'; return; }
      x.decision = { admin, at:this.now(), messageId: String(evt.messageId ?? ''), quote };
      this.state(x, choice==='1' ? 'queued' : 'rejected');
      message = choice==='1' ? `已同意 ${x.id}，进入生图队列` : `已拒绝 ${x.id}，不会请求收费接口`;
    });
    this.kick();
    if (this.active) { try { await this.sendText(convKey,message); } catch {} }
    return true;
  }
  async query(id, caller, chat) {
    await this.chain;
    const t=this.db.tasks.find((v)=>v.id===id && this.canAccess(v,caller));
    const view=this.view(t);
    if(t && caller?.convKey===t.convKey && typeof chat?.registerMedia==='function') {
      for(const [index,image] of t.images.entries()) {
        const r=await chat.registerMedia({path:image.path,kind:'image',mime:image.mime});
        if(r?.ok && r.handle) view.images[index].handle=r.handle;
      }
    }
    return view;
  }
  async cancel(id, caller) {
    let cancelled=false;
    const r = await this.tx((db) => {
      const t=db.tasks.find((v)=>v.id===id && this.canAccess(v,caller)); if (!t) return this.view(null);
      if (TERMINAL.has(t.state)) return this.view(t);
      const generating=t.state==='generating'; cancelled=true;
      this.state(t,generating ? 'outcome_unknown' : 'cancelled', 'USER_CANCELLED', generating ? '收费请求中止，可能已计费；不再生成或投递' : '用户取消后不再开始生成或投递');
      return this.view(t);
    });
    if(cancelled) this.running.get(id)?.abort(); return r;
  }
  async retryDelivery(id, caller) {
    const r=await this.tx((db) => {
      const t=db.tasks.find((v)=>v.id===id && this.canAccess(v,caller)); if (!t) return this.view(null);
      if (!this.active || t.state!=='delivery_failed' || !t.generationSucceeded || !t.images.length) return { ok:false, code:'IMAGE_NOT_RETRYABLE', message:'只有已生成但投递失败的任务可重试投递' };
      this.state(t,'generated'); t.nextDeliveryAt=0; t.deliveryAttempts=0; return this.view(t);
    }); this.kick(); return r;
  }
  kick() { if (this.active && !this.fault) queueMicrotask(()=>this.pump()); }
  pump() {
    if (!this.active || this.fault) return;
    const todo=this.db.tasks.filter((t) => !this.running.has(t.id) && (t.state==='queued' || t.state==='generated'));
    for (const t of todo) {
      if (this.running.size>=this.cfg.concurrency) break;
      const controller=new AbortController(); this.running.set(t.id,controller);
      this.track(this.run(t.id,controller).finally(()=>{ this.running.delete(t.id); this.kick(); }));
    }
  }
  async run(id, controller) {
    let t=this.db.tasks.find((x)=>x.id===id);
    if (t.state==='queued') {
      const claimed=await this.tx((db)=>{ const x=db.tasks.find((v)=>v.id===id); if(!this.active || controller.signal.aborted || x.state!=='queued') return false;
        this.state(x,'generating'); x.requestStartedAt=this.now(); return true; });
      if (!claimed || !this.active || controller.signal.aborted) return;
      try {
        const images=await this.generate({snapshot:copy(t.snapshot), apiKey:this.apiKey,signal:controller.signal});
        if (!this.active || controller.signal.aborted) return;
        await this.tx((db)=>{const x=db.tasks.find((v)=>v.id===id); if(x.state==='generating') x.generationSucceeded=true;});
        const saved=[];
        for (const [index,i] of images.entries()) {
          if (!['png','jpg','webp','gif'].includes(i.extension) || !Buffer.isBuffer(i.buffer) || i.buffer.length>t.snapshot.maxImageBytes) throw new Error('生成返回不合法媒体');
          const relative=`images/${id.slice(4)}-${index}.${i.extension}`;
          const f=await fs.open(path.join(this.dir,relative),'wx'); try { await f.writeFile(i.buffer); await f.sync(); } finally { await f.close(); }
          this.diskBytes += i.buffer.length;
          saved.push({path:relative,mime:i.mime,bytes:i.buffer.length,handle:null,deliveredAt:null});
        }
        await this.tx((db)=>{ const x=db.tasks.find((v)=>v.id===id); if(x.state!=='generating') return;
          x.images=saved; x.generationSucceeded=true; this.state(x,'generated'); });
      } catch(e) {
        await this.tx((db)=>{ const x=db.tasks.find((v)=>v.id===id); if(x.state!=='generating') return;
          this.state(x,x.generationSucceeded || e.outcomeUnknown===false ? 'failed' : 'outcome_unknown',e.code ?? (x.generationSucceeded ? 'IMAGE_SAVE_FAILED' : 'GENERATION_RESULT_UNKNOWN'), x.generationSucceeded ? '生图成功但本地保存失败，不会重新计费生成' : e.outcomeUnknown===false ? '生图请求被明确拒绝；未自动重试' : '收费请求结果不明，不会自动重新生成'); });
        return;
      }
    }
    t=this.db.tasks.find((x)=>x.id===id);
    if (!this.active || controller.signal.aborted || t.state!=='generated') return;
    const claimed=await this.tx((db)=>{ const x=db.tasks.find((v)=>v.id===id); if(!this.active || controller.signal.aborted || x.state!=='generated') return false;
      this.state(x,'delivering'); x.deliveryAttempts++; return true; });
    if (!claimed) return;
    for (let index=0; index<t.images.length; index++) {
      const current=this.db.tasks.find((x)=>x.id===id);
      if (!this.active || controller.signal.aborted || current.state!=='delivering') return;
      if(current.images[index].deliveredAt) continue;
      let r; try { r=await this.deliverMedia({convKey:t.convKey,path:t.images[index].path,kind:'image',mime:t.images[index].mime,signal:controller.signal,auditText:`生图 ${id} 第${index+1}张`}); }
      catch { r={ok:false,code:'DELIVERY_ERROR'}; }
      await this.tx((db)=>{ const x=db.tasks.find((v)=>v.id===id);
        if (r?.ok) Object.assign(x.images[index],{deliveredAt:this.now(),messageId:r.messageId ?? null,handle:r.handle || null});
        if(x.state!=='delivering') return;
        if(!r?.ok) { this.state(x,'delivery_failed',String(r?.code ?? 'DELIVERY_ERROR').slice(0,80),'图片已生成，仅投递失败；重试只发已保存图片'); x.nextDeliveryAt=this.now()+this.cfg.deliveryRetryMs; }
      });
      if (!r?.ok) return;
    }
    await this.tx((db)=>{ const x=db.tasks.find((v)=>v.id===id); if(x.state==='delivering') this.state(x,'delivered'); });
  }
  async maintenance() {
    if (!this.active || this.fault) return;
    const now=this.now();
    if (this.db.tasks.some((t)=> t.state==='pending' && t.expiresAt<=now || t.state==='delivery_failed' && t.error?.code!=='DELIVERY_INTERRUPTED' && t.deliveryAttempts<this.cfg.deliveryAttempts && t.nextDeliveryAt<=now)) {
      await this.tx((db)=>{ for(const t of db.tasks) {
        if(t.state==='pending' && t.expiresAt<=now) this.state(t,'expired');
        if(t.state==='delivery_failed' && t.error?.code!=='DELIVERY_INTERRUPTED' && t.deliveryAttempts<this.cfg.deliveryAttempts && t.nextDeliveryAt<=now) this.state(t,'generated');
      }}); this.kick();
    }
    if (!this.lastCleanup || now-this.lastCleanup>3600000) await this.cleanup();
  }
  async cleanup() {
    this.lastCleanup=this.now(); const cutoff=this.now()-this.cfg.retentionDays*86400000;
    const expired=await this.tx((db)=>{
      const removed=db.tasks.filter((t)=>(TERMINAL.has(t.state) || t.state==='delivery_failed') && t.state!=='outcome_unknown' && t.updatedAt<cutoff && !this.running.has(t.id));
      const ids=new Set(removed.map((t)=>t.id)); db.tasks=db.tasks.filter((t)=>!ids.has(t.id)); return removed;
    });
    if(expired.length) {
      for(const t of expired) for(const i of t.images) {
        const target=path.resolve(this.dir,i.path);
        if(path.dirname(target)!==this.imagesDir) throw new Error('清理媒体路径不合法');
        await fs.unlink(target).catch((e)=>{if(e.code!=='ENOENT') throw e;});
      }
    }
    const retained=new Set(this.db.tasks.flatMap((t)=>t.images.map((i)=>path.basename(i.path))));
    for(const e of await fs.readdir(this.imagesDir,{withFileTypes:true})) {
      if (!e.isFile() || !/^[a-f0-9-]{36}-\d+\.(png|jpg|webp|gif)$/.test(e.name) || retained.has(e.name)) continue;
      const target=path.join(this.imagesDir,e.name); const st=await fs.stat(target);
      // 活跃任务可能刚写图还未提交元数据；至少保留一天才清孤儿。
      if(st.mtimeMs<this.now()-86400000) await fs.unlink(target);
    }
    for(const e of await fs.readdir(this.dir,{withFileTypes:true})) {
      if(!e.isFile() || !/^\.tasks-[a-f0-9-]{36}\.tmp$/.test(e.name)) continue;
      const target=path.join(this.dir,e.name);
      if((await fs.stat(target)).mtimeMs<this.now()-86400000) await fs.unlink(target);
    }
    this.diskBytes=0;
    for(const e of await fs.readdir(this.imagesDir,{withFileTypes:true})) {
      if(e.isFile()) this.diskBytes+=(await fs.stat(path.join(this.imagesDir,e.name))).size;
    }
  }
  dispose() {
    if(this.stopping) return this.stopping;
    this.active=false; clearInterval(this.timer);
    for(const c of this.running.values()) c.abort();
    this.stopping=this.stop(); return this.stopping;
  }
  async stop() {
    try { await this.initializing; } catch { return; }
    if(!this.hasLock || this.fault) return;
    await this.tx((db)=>{ for(const t of db.tasks) {
      if(t.state==='generating') this.state(t,'outcome_unknown','PLUGIN_STOPPED','插件停用打断收费请求，禁止自动重发');
      else if(['pending','queued'].includes(t.state)) this.state(t,'cancelled','PLUGIN_STOPPED','插件已停用，需要重新提交审批');
      else if(['generated','delivering'].includes(t.state)) this.state(t,'delivery_failed','DELIVERY_INTERRUPTED','插件停用，已保存图片；重新启用后可显式重试投递');
    }});
  }
  releaseLock() {
    if(!this.releasing) this.releasing=this.unlock();
    return this.releasing;
  }
  async unlock() {
    if(!this.hasLock) return;
    const lock=JSON.parse(await fs.readFile(this.lockFile,'utf8'));
    if(lock.token!==this.lockToken) throw new Error('任务目录锁归属改变');
    await fs.unlink(this.lockFile); this.hasLock=false;
  }
  async idle() { while(this.work.size) await Promise.all([...this.work]); await this.chain; }
}
