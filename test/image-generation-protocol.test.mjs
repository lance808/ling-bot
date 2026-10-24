import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { generateImages, generationsEndpoint } from '../plugins/image-generation/lib/generate.mjs';

// Tiny real PNG; no service credentials or external network is used.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const SECRET = 'unit-test-key-never-real';
const base = { apiUrl: 'http://127.0.0.1:1/v1', model: 'test-model', size: '1024x1024', count: 1, prompt: 'a cloud', timeoutMs: 1000, maxImageBytes: 1024 };
const jsonResponse = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const inline = (buffer = PNG) => ({ data: [{ b64_json: buffer.toString('base64') }] });
const call = (extra = {}, changes = {}) => generateImages({ snapshot: { ...base, ...changes }, apiKey: SECRET, ...extra });
const isError = (code, unknown = true) => (error) => {
  assert.equal(error.code, code);
  assert.equal(error.outcomeUnknown, unknown);
  assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /unit-test-key-never-real|PRIVATE-UPSTREAM/);
  assert.equal(error.cause, undefined);
  return true;
};
async function server(t, handler) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return `http://127.0.0.1:${instance.address().port}`;
}
const publicDownload = (request) => ({
  resolveHost: async () => ['8.8.8.8'],
  requestOnce: request ?? (async () => ({ statusCode: 200, headers: {}, buffer: PNG })),
});

test('protocol can load from an isolated module without checkout-relative imports', async () => {
  const source = await readFile(new URL('../plugins/image-generation/lib/generate.mjs', import.meta.url), 'utf8');
  const portable = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const result = await portable.generateImages({ snapshot: base, apiKey: SECRET, fetchImpl: async () => jsonResponse(inline()) });
  assert.deepEqual(result, [{ buffer: PNG, mime: 'image/png', extension: 'png' }]);
});

test('generationsEndpoint accepts explicit local HTTP and already complete endpoints', () => {
  assert.equal(generationsEndpoint(' http://127.0.0.1:8123/v1/// '), 'http://127.0.0.1:8123/v1/images/generations');
  assert.equal(generationsEndpoint('https://example.com/v1/images/generations/'), 'https://example.com/v1/images/generations');
  assert.equal(generationsEndpoint('http://[::1]:8123'), 'http://[::1]:8123/images/generations');
  for (const url of ['', 'invalid', 'file:///secret', 'https://name:pass@example.com', 'https://example.com?secret=1', 'https://example.com#secret', 'https://example.com?', 'https://example.com#']) {
    assert.throws(() => generationsEndpoint(url), isError('CONFIG_BAD_API_URL', false));
  }
});

test('real local HTTP POST sends only text-generation fields and returns raw bytes', async (t) => {
  let calls = 0;
  const url = await server(t, async (req, res) => {
    calls++;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/images/generations');
    assert.equal(req.headers.authorization, `Bearer ${SECRET}`);
    const parts = [];
    for await (const part of req) parts.push(part);
    assert.deepEqual(JSON.parse(Buffer.concat(parts)), {
      prompt: 'a cloud', model: 'test-model', size: '1024x1024', n: 1, response_format: 'b64_json',
    });
    res.end(JSON.stringify(inline()));
  });
  const result = await call({}, { apiUrl: `${url}/v1`, image: 'must-not-be-sent', quality: 'must-not-be-sent' });
  assert.deepEqual(result, [{ buffer: PNG, mime: 'image/png', extension: 'png' }]);
  assert.equal(calls, 1);
});

test('local HTTP timeout aborts body drip, marks uncertainty, and never retries', async (t) => {
  let calls = 0;
  const url = await server(t, (_req, res) => {
    calls++;
    res.writeHead(200);
    res.write('{"data":[');
    const drip = setInterval(() => res.write(' '), 5);
    res.on('close', () => clearInterval(drip));
  });
  const start = Date.now();
  await assert.rejects(call({}, { apiUrl: url, timeoutMs: 100 }), isError('UPSTREAM_TIMEOUT'));
  assert.ok(Date.now() - start < 1500);
  assert.equal(calls, 1);
});

test('POST redirects are rejected without contacting the target or leaking its key', async (t) => {
  let requests = 0;
  const url = await server(t, (req, res) => {
    requests++;
    res.writeHead(307, { location: '/should-not-run' });
    res.end('PRIVATE-UPSTREAM');
  });
  await assert.rejects(call({}, { apiUrl: url }), isError('UPSTREAM_REDIRECT'));
  assert.equal(requests, 1);
});

test('explicit 4xx is known failure; 5xx and transport failures are unknown and never retried', async (t) => {
  for (const status of [400, 401, 403, 429, 500, 502, 503]) {
    let calls = 0;
    const url = await server(t, (_req, res) => {
      calls++;
      res.writeHead(status);
      res.end(`PRIVATE-UPSTREAM ${SECRET}`);
    });
    await assert.rejects(call({}, { apiUrl: url }), isError('UPSTREAM_HTTP_ERROR', status >= 500));
    assert.equal(calls, 1);
  }
  let attempts = 0;
  await assert.rejects(call({ fetchImpl: async () => { attempts++; throw new Error(`PRIVATE-UPSTREAM ${SECRET}`); } }), isError('UPSTREAM_UNREACHABLE'));
  assert.equal(attempts, 1);
});

test('real HTTP response cap and abrupt disconnect are unknown outcomes without retries', async (t) => {
  for (const mode of ['oversized', 'disconnect']) {
    let calls = 0;
    const url = await server(t, (_req, res) => {
      calls++;
      if (mode === 'oversized') {
        res.writeHead(200, { 'content-length': '1000000' });
        res.end('PRIVATE-UPSTREAM');
      } else {
        res.socket.destroy();
      }
    });
    await assert.rejects(call({}, { apiUrl: url }), isError(mode === 'oversized' ? 'UPSTREAM_TOO_LARGE' : 'UPSTREAM_UNREACHABLE'));
    assert.equal(calls, 1);
  }
  const spoofed = Object.assign(new Error(`PRIVATE-UPSTREAM ${SECRET}`), {
    name: 'ImageGenerationError', code: 'FAKE', outcomeUnknown: false,
  });
  await assert.rejects(call({ fetchImpl: async () => { throw spoofed; } }), isError('UPSTREAM_UNREACHABLE'));
});

test('validation and cancellation before POST report outcomeUnknown=false', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return jsonResponse(inline()); };
  for (const changes of [{ count: 0 }, { count: 9 }, { count: 1.5 }, { timeoutMs: 0 }, { maxImageBytes: 0 }, { maxImageBytes: 64 * 1024 * 1024 + 1 }, { model: 1 }]) {
    await assert.rejects(call({ fetchImpl }, changes), isError('CONFIG_BAD_SNAPSHOT', false));
  }
  await assert.rejects(call({ fetchImpl }, { prompt: ' ' }), isError('BAD_PROMPT', false));
  await assert.rejects(call({ fetchImpl, apiKey: '' }), isError('CONFIG_BAD_API_KEY', false));
  await assert.rejects(call({ fetchImpl, apiKey: 'bad\nkey' }), isError('CONFIG_BAD_API_KEY', false));
  const controller = new AbortController();
  controller.abort(new Error(`PRIVATE-UPSTREAM ${SECRET}`));
  await assert.rejects(call({ fetchImpl, signal: controller.signal }), isError('UPSTREAM_ABORTED', false));
  assert.equal(calls, 0);
});

test('post-submit external abort and a noncooperating fetch still obey the total budget', async () => {
  const controller = new AbortController();
  let sent;
  const began = new Promise((resolve) => { sent = resolve; });
  const pending = call({ signal: controller.signal, fetchImpl: async () => { sent(); return new Promise(() => {}); } });
  await began;
  controller.abort(new Error(`PRIVATE-UPSTREAM ${SECRET}`));
  await assert.rejects(pending, isError('UPSTREAM_ABORTED'));
  await assert.rejects(call({ fetchImpl: async () => new Promise(() => {}) }, { timeoutMs: 20 }), isError('UPSTREAM_TIMEOUT'));
});

test('JSON parsing, empty rows and excess output count have sanitized error codes', async () => {
  for (const [body, code] of [[null, 'UPSTREAM_NO_IMAGE'], [{ error: { message: `PRIVATE-UPSTREAM ${SECRET}` } }, 'UPSTREAM_NO_IMAGE'], [{ data: [] }, 'UPSTREAM_NO_IMAGE'], [{ data: [{}] }, 'UPSTREAM_BAD_IMAGE_ROW'], [{ data: [inline().data[0], inline().data[0]] }, 'UPSTREAM_IMAGE_COUNT']]) {
    await assert.rejects(call({ fetchImpl: async () => jsonResponse(body) }), isError(code));
  }
  await assert.rejects(call({ fetchImpl: async () => new Response(`PRIVATE-UPSTREAM ${SECRET}`) }), isError('UPSTREAM_BAD_JSON'));
  await assert.rejects(call({ fetchImpl: async () => new Response(Uint8Array.from([0xff])) }), isError('UPSTREAM_BAD_JSON'));
});

test('canonical base64 and complete magic bytes are required; MIME hints are untrusted', async () => {
  const good = PNG.toString('base64');
  for (const b64_json of ['', `${good}\n`, good.slice(0, -1), `!${good}`, 'AA=A', 'AB==', 'AAB=', 'data:text/plain;base64,' + good, 'data:image/png;base64,@@==']) {
    await assert.rejects(call({ fetchImpl: async () => jsonResponse({ data: [{ b64_json }] }) }), isError('UPSTREAM_BAD_BASE64'));
  }
  for (const buffer of [Buffer.from('PRIVATE-UPSTREAM'), Buffer.from([0x89, 0x50, ...Array(20).fill(0)]), Buffer.from([0xff, 0xd8, 0x00, ...Array(20).fill(0)])]) {
    await assert.rejects(call({ fetchImpl: async () => jsonResponse(inline(buffer)) }), isError('UPSTREAM_BAD_IMAGE'));
  }
  const png = await call({ fetchImpl: async () => jsonResponse({ data: [{ b64_json: `data:image/jpeg;base64,${good}` }] }) });
  assert.equal(png[0].mime, 'image/png');
  for (const [buffer, mime, extension] of [
    [Buffer.from('ffd8ffe000104a4649460001', 'hex'), 'image/jpeg', 'jpg'],
    [Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(6)]), 'image/gif', 'gif'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]), 'image/webp', 'webp'],
  ]) {
    assert.deepEqual(await call({ fetchImpl: async () => jsonResponse(inline(buffer)) }), [{ buffer, mime, extension }]);
  }
});

test('inline limits are checked before decode and response limit scales with count', async () => {
  await assert.rejects(call({ fetchImpl: async () => jsonResponse(inline()) }, { maxImageBytes: PNG.length - 1 }), isError('UPSTREAM_IMAGE_TOO_LARGE'));
  const large = Buffer.concat([PNG, Buffer.alloc(500)]);
  assert.equal((await call({ fetchImpl: async () => jsonResponse(inline(large)) }, { maxImageBytes: large.length }))[0].buffer.length, large.length);
  const body = { data: [inline().data[0], inline().data[0]], padding: 'x'.repeat(90_000) };
  await assert.rejects(call({ fetchImpl: async () => jsonResponse(body) }, { count: 1 }), isError('UPSTREAM_TOO_LARGE'));
  assert.equal((await call({ fetchImpl: async () => jsonResponse(body) }, { count: 2 })).length, 2);
});

test('response streaming and content-length enforce a hard 64 MiB ceiling', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(4096)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(call({ fetchImpl: async () => new Response(stream) }), isError('UPSTREAM_TOO_LARGE'));
  assert.equal(cancelled, true);
  // Above the hard cap must fail before reading, even with the largest snapshot.
  await assert.rejects(call({ fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }) }, { count: 8, maxImageBytes: 64 * 1024 * 1024 }), isError('UPSTREAM_TOO_LARGE'));
  let chunks = 0;
  const huge = new ReadableStream({ pull(controller) {
    chunks++;
    controller.enqueue(new Uint8Array(1024 * 1024));
  } });
  await assert.rejects(call({ fetchImpl: async () => new Response(huge) }, { count: 8, maxImageBytes: 64 * 1024 * 1024, timeoutMs: 5000 }), isError('UPSTREAM_TOO_LARGE'));
  assert.ok(chunks <= 67, `read ${chunks} MiB chunks`);
});

test('URL and image_url strings/nesting use DNS-pinned safe downloads without API credentials', async () => {
  for (const row of [{ url: 'https://images.example/a?signature=ok' }, { url: { url: 'https://images.example/a' } }, { image_url: 'https://images.example/a' }, { image_url: { url: 'https://images.example/a' } }]) {
    let requests = 0;
    const result = await call({
      fetchImpl: async () => jsonResponse({ data: [row] }),
      downloadDeps: publicDownload(async (input) => {
        requests++;
        assert.equal(input.ip, '8.8.8.8');
        assert.equal(input.url.hostname, 'images.example');
        assert.equal(input.maxBytes, base.maxImageBytes + 1);
        assert.ok(input.timeoutMs <= base.timeoutMs);
        assert.equal(input.signal.aborted, false);
        assert.equal(input.headers, undefined);
        assert.ok(!JSON.stringify(input).includes(SECRET));
        return { statusCode: 200, headers: { 'content-type': 'text/plain' }, buffer: PNG };
      }),
    });
    assert.deepEqual(result, [{ buffer: PNG, mime: 'image/png', extension: 'png' }]);
    assert.equal(requests, 1);
  }
});

test('default safe download transport pins IP and bounds real HTTP bytes', async (t) => {
  let downloads = 0;
  const local = await server(t, (req, res) => {
    downloads++;
    assert.equal(req.headers.host, 'images.example');
    assert.equal(req.headers.authorization, undefined);
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); }
    else if (req.url === '/large') res.end(Buffer.alloc(1025));
    else res.end(PNG);
  });
  const original = http.request;
  // Replace only the final socket destination, after observing the exact pinned
  // options. This exercises the production stream/abort transport offline.
  t.mock.method(http, 'request', (options, callback) => {
    assert.equal(options.hostname, '8.8.8.8');
    assert.equal(options.headers.host, 'images.example');
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.cookie, undefined);
    return original({ ...options, hostname: '127.0.0.1', port: new URL(local).port }, callback);
  });
  const run = (path, changes) => call({
    fetchImpl: async () => jsonResponse({ data: [{ url: `http://images.example/${path}` }] }),
    downloadDeps: { resolveHost: async () => ['8.8.8.8'] },
  }, changes);
  assert.deepEqual(await run('ok', { maxImageBytes: PNG.length }), [{ buffer: PNG, mime: 'image/png', extension: 'png' }]);
  await assert.rejects(run('redirect'), isError('UPSTREAM_IMAGE_REDIRECT'));
  await assert.rejects(run('large'), isError('UPSTREAM_IMAGE_TOO_LARGE'));
  assert.equal(downloads, 3);
});

test('image URL SSRF rejects local, private, mapped, metadata and non-HTTP targets before download', async () => {
  let requests = 0;
  const downloadDeps = publicDownload(async () => { requests++; throw new Error('should not run'); });
  for (const url of ['file:///C:/secret', 'data:image/png;base64,abc', 'http://127.0.0.1/a', 'http://2130706433/a', 'http://0x7f000001/a', 'http://10.1.1.1/a', 'http://169.254.169.254/a', 'http://[::1]/a', 'http://[::ffff:7f00:1]/a', 'http://[64:ff9b::7f00:1]/a', 'http://localhost./a', 'http://host.internal/a', 'https://u:p@images.example/a', 'https://images.example/a#fragment']) {
    await assert.rejects(call({ fetchImpl: async () => jsonResponse({ data: [{ url }] }), downloadDeps }), isError('UPSTREAM_IMAGE_URL_BLOCKED'));
  }
  assert.equal(requests, 0);
});

test('DNS checks every result, rejects invalid answers, and pins only one validated resolution', async () => {
  let requests = 0;
  for (const answers of [['127.0.0.1'], ['8.8.8.8', '10.0.0.1'], ['8.8.8.8', '::1'], ['8.8.8.8', 'not-an-ip']]) {
    await assert.rejects(call({ fetchImpl: async () => jsonResponse({ data: [{ url: 'https://images.example/a' }] }), downloadDeps: {
      resolveHost: async () => answers,
      requestOnce: async () => { requests++; },
    } }), isError('UPSTREAM_IMAGE_URL_BLOCKED'));
  }
  let resolutions = 0;
  await call({ fetchImpl: async () => jsonResponse({ data: [{ url: 'https://images.example/a' }] }), downloadDeps: {
    resolveHost: async () => { resolutions++; return resolutions === 1 ? ['8.8.8.8'] : ['127.0.0.1']; },
    requestOnce: async (input) => { assert.equal(input.ip, '8.8.8.8'); return { statusCode: 200, buffer: PNG }; },
  } });
  assert.equal(resolutions, 1);
  assert.equal(requests, 0);
});

test('all image redirects are refused with no second hop, including redirects into private networks', async () => {
  for (const statusCode of [301, 302, 303, 307, 308]) {
    let requests = 0;
    await assert.rejects(call({ fetchImpl: async () => jsonResponse({ data: [{ url: 'https://images.example/a' }] }), downloadDeps: publicDownload(async () => {
      requests++;
      return { statusCode, headers: { location: 'http://169.254.169.254/secret' }, buffer: Buffer.alloc(0) };
    }) }), isError('UPSTREAM_IMAGE_REDIRECT'));
    assert.equal(requests, 1);
  }
});

test('downloads reject oversized, truncated and non-image bytes; hard limit is 10 MiB', async () => {
  const run = (response, changes) => call({ fetchImpl: async () => jsonResponse({ data: [{ url: 'https://images.example/a' }] }), downloadDeps: publicDownload(async () => response) }, changes);
  await assert.rejects(run({ statusCode: 200, buffer: Buffer.alloc(1025) }), isError('UPSTREAM_IMAGE_TOO_LARGE'));
  await assert.rejects(run({ statusCode: 200, buffer: PNG, truncated: true }), isError('UPSTREAM_IMAGE_TOO_LARGE'));
  await assert.rejects(run({ statusCode: 200, buffer: Buffer.from('PRIVATE-UPSTREAM') }), isError('UPSTREAM_BAD_IMAGE'));
  await assert.rejects(run({ statusCode: 404, buffer: PNG }), isError('UPSTREAM_IMAGE_DOWNLOAD_FAILED'));
  const exact = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 - PNG.length)]);
  let limit;
  const downloadDeps = publicDownload(async (input) => { limit = input.maxBytes; return { statusCode: 200, buffer: exact }; });
  assert.equal((await call({ fetchImpl: async () => jsonResponse({ data: [{ url: 'https://images.example/a' }] }), downloadDeps }, { maxImageBytes: 20 * 1024 * 1024 }))[0].buffer.length, exact.length);
  assert.equal(limit, exact.length + 1);
  await assert.rejects(run({ statusCode: 200, buffer: Buffer.concat([exact, Buffer.alloc(1)]) }, { maxImageBytes: 20 * 1024 * 1024 }), isError('UPSTREAM_IMAGE_TOO_LARGE'));
});

test('total deadline covers DNS and injected downloads even when they ignore abort', async () => {
  let requested = 0;
  const urlResponse = async () => jsonResponse({ data: [{ url: 'https://images.example/a' }] });
  let release;
  const dns = new Promise((resolve) => { release = resolve; });
  await assert.rejects(call({ fetchImpl: urlResponse, downloadDeps: {
    resolveHost: () => dns,
    requestOnce: async () => { requested++; return { statusCode: 200, buffer: PNG }; },
  } }, { timeoutMs: 20 }), isError('UPSTREAM_TIMEOUT'));
  release(['8.8.8.8']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requested, 0);
  await assert.rejects(call({ fetchImpl: urlResponse, downloadDeps: publicDownload(async () => new Promise(() => {})) }, { timeoutMs: 20 }), isError('UPSTREAM_TIMEOUT'));
});
