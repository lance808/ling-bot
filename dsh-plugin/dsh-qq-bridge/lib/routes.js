/**
 * 设置页的数据接口（host 半的 HTTP 路由）
 *
 * ## 为什么不用 DSH 的 settings RPC
 *
 * 那套契约会随内核版本变；而 `/api/*` 是外壳自己挂的稳定入口。
 * 用最长前缀派发意味着我们这条自定义路由会**抢在** `/api` 的鉴权之前跑，
 * 所以这里必须自己做鉴权——不能假设外壳已经挡过了。
 *
 * ## 令牌怎么处理
 *
 * 读：只返回"有没有配"，**绝不回显**。
 * 写：空字符串 = 不改（跟平台 secret 字段的语义一致）。
 * 清：必须显式调 clear-token（走 `unset` 而不是写空串——
 *     在 secret 字段上写空串等于"没改"，会静默失败）。
 */

import { resolveBridgeUrl, readDiscovery } from './discovery.js';

const NS = 'dsh-qq-bridge';

/**
 * @param {any} webServer 外壳的 webServer 服务
 * @param {object} deps
 * @param {() => any} deps.readConfig 读当前生效配置
 * @param {(patch: object) => Promise<void>} deps.updateConfig
 * @param {() => Promise<void>} deps.clearToken
 * @param {any} deps.connection 用于鉴权
 * @param {() => void} deps.log
 * @returns {() => void} dispose
 */
export function registerBridgeRoutes(webServer, deps) {
  const log = deps.log ?? (() => {});

  /** 统一的 JSON 回包 */
  const json = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  };

  /**
   * 鉴权。
   *
   * 自定义前缀路由先于 `/api` 派发，所以这一步不能省。
   *
   * ⚠️ 用的是 `connection.requestRejection(request)`，**不是** `isAuthenticated`。
   *    后者根本不存在——之前调用它时异常被 catch 吞掉、统一返回 false，
   *    结果就是**带着合法浏览器会话过来也一律 401**，而界面上只说"保存失败"。
   *    这类"凭想象写 API"的错误语法层不会暴露，只能靠对照契约。
   *
   * 返回 undefined = 放行；返回 401/403 = 拒绝。
   * 拿不到 connection（或它没有这个方法）时**拒绝**——fail-closed。
   */
  const rejectionOf = (req) => {
    const conn = deps.connection;
    if (!conn) return 401;
    try {
      if (typeof conn.requestRejection === 'function') {
        const r = conn.requestRejection({ headers: req.headers ?? {} });
        return r === 401 || r === 403 ? r : undefined;
      }
      // 没有 requestRejection 说明宿主版本对不上，不能猜，直接拒
      return 401;
    } catch {
      return 401;
    }
  };

  /** 读请求体（带大小上限） */
  const readBody = async (req) => {
    const MAX = 32 * 1024;
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX) throw new Error('请求体过大');
    }
    return raw.trim() ? JSON.parse(raw) : {};
  };

  const handler = async (req, res) => {
    const rejection = rejectionOf(req);
    if (rejection) {
      return json(res, rejection, {
        ok: false,
        error: rejection === 403 ? '来源不被允许' : '未通过鉴权（浏览器会话无效或已过期，刷新页面重试）',
      });
    }

    const route = (req.url ?? '/').split('?')[0];

    // ---- 读配置 ----
    if (route === '/api/qq-bridge/config' && req.method === 'GET') {
      const c = deps.readConfig() ?? {};
      const explicit = String(c.bridgeUrl ?? '');
      const effective = resolveBridgeUrl(explicit);
      return json(res, 200, {
        ok: true,
        bridgeUrl: explicit,
        // 用户没填时，实际会连的地址（自动发现来的）
        effectiveUrl: effective ?? '',
        // 是自动发现的还是手填的，界面上要能区分
        discovered: !explicit && Boolean(effective),
        // 只告诉"有没有"，永远不回显令牌本身
        hasToken: Boolean(String(c.bridgeToken ?? '')),
        admins: String(c.admins ?? ''),
        relayApprovals: c.relayApprovals === true,
        onUnreachable: String(c.onUnreachable ?? ''),
      });
    }

    // ---- 写配置 ----
    if (route === '/api/qq-bridge/config' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        /** @type {Record<string, any>} */
        const patch = {};

        if (typeof body.bridgeUrl === 'string') patch.bridgeUrl = body.bridgeUrl.trim();
        if (typeof body.admins === 'string') patch.admins = body.admins.trim();
        if (typeof body.relayApprovals === 'boolean') patch.relayApprovals = body.relayApprovals;
        if (typeof body.onUnreachable === 'string') patch.onUnreachable = body.onUnreachable.trim();

        // 空字符串 = 不改。这是平台对 secret 字段的语义，
        // 照做才不会被"保存一次把令牌清掉"坑到。
        if (typeof body.bridgeToken === 'string' && body.bridgeToken.trim()) {
          patch.bridgeToken = body.bridgeToken.trim();
        }

        if (Object.keys(patch).length === 0) {
          return json(res, 400, { ok: false, error: '没有要改的字段' });
        }

        await deps.updateConfig(patch);
        log(`配置已更新：${Object.keys(patch).join(', ')}`);
        return json(res, 200, { ok: true, changed: Object.keys(patch) });
      } catch (err) {
        const e = /** @type {any} */ (err);
        log(`写配置失败：${String(e?.code ?? '')} ${String(e?.message ?? e)}`);
        if (e?.stack) log(`stack: ${String(e.stack).split('\n').slice(0, 3).join(' | ')}`);
        return json(res, 500, { ok: false, error: String(e?.message ?? e) });
      }
    }

    // ---- 清令牌 ----
    if (route === '/api/qq-bridge/config/clear-token' && req.method === 'POST') {
      try {
        await deps.clearToken();
        log('令牌已清除');
        return json(res, 200, { ok: true });
      } catch (err) {
        const e = /** @type {any} */ (err);
        return json(res, 500, { ok: false, error: String(e?.message ?? e) });
      }
    }

    return json(res, 404, { ok: false, error: `没有这个路由：${route}` });
  };

  // WebRoute 的形状是**一个对象** { kind, path, handler }，
  // 不是 (handler, opts)。传错的话注册不会报错，但路由永远匹配不上，
  // 请求会落到兜底处理器返回纯文本 "not found"——
  // 前端 parse 那个响应就得到 "Unexpected token 'o'"。
  //
  // kind 用 'prefix'：这样 /api/qq-bridge/config 和 .../config/clear-token
  // 都归这条路由处理，不必为每条子路径各注册一次。
  const dispose = webServer.register({
    kind: 'prefix',
    path: '/api/qq-bridge',
    handler,
  });
  log('设置页接口已挂载：/api/qq-bridge/*');
  return typeof dispose === 'function' ? dispose : () => {};
}

export { NS };
