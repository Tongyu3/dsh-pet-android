/**
 * DSHA 适配器单测 —— 用假 3090 桥验证 token 发现、版本探测、悬浮条推文、去重与冷却。
 *
 * 契约依据：DSHA 的 HttpShellService.appOverlay 返回
 *   DISABLED / NO_PERMISSION / SKIP_REASONING / OK / OK_NO_CMD，且鉴权头是 X-Token；
 *   /app/version 返回 BRIDGE_PROTOCOL=… APP_VERSION=… APP_CODE=…
 * 跑法：node test/dsha.test.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { DshaBridge } = await import('../src/adapters/dsha.js');

const TOKEN = 'test-bridge-token';
const calls = [];
let overlayMode = 'ok';

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const auth = req.headers['x-token'];
  calls.push({ path: url.pathname, auth, q: Object.fromEntries(url.searchParams) });
  if (auth !== TOKEN) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end('{"result":"UNAUTHORIZED"}');
  }
  if (url.pathname === '/app/version') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('BRIDGE_PROTOCOL=4\nBRIDGE_AUTH=header-x-token\nAPP_VERSION=0.2.24\nAPP_CODE=173\n');
  }
  if (url.pathname === '/app/overlay') {
    const kind = url.searchParams.get('kind');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (kind === 'clear') return res.end('{"result":"OK"}');
    if (overlayMode === 'disabled') return res.end('{"result":"DISABLED"}');
    if (overlayMode === 'no-permission') return res.end('{"result":"NO_PERMISSION"}');
    return res.end('{"result":"OK"}');
  }
  res.writeHead(404);
  res.end('nope');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const home = mkdtempSync(join(tmpdir(), 'dsha-bridge-'));
writeFileSync(join(home, '.bridge_token'), TOKEN + '\n', 'utf8');

// 1) 没有 token 的目录 → 不探测、不可用
{
  const bare = mkdtempSync(join(tmpdir(), 'dsha-bare-'));
  const b = new DshaBridge({ base, dshHome: bare });
  assert.equal(await b.probe(), false, '没有 token 时探测必须失败');
  assert.equal(b.usable, false);
  rmSync(bare, { recursive: true, force: true });
}

// 2) 正常探测：token 头 + 版本解析
{
  const b = new DshaBridge({ base, dshHome: home });
  assert.equal(await b.probe(), true, '有 token 且 /app/version 可达时必须探测成功');
  assert.equal(b.version, '0.2.24');
  assert.equal(b.tokenSource, join(home, '.bridge_token'));
  assert.equal(b.usable, true);
  assert.ok(calls.every((c) => c.auth === TOKEN), '每个请求都必须带 X-Token');

  // 3) 推一行：OK、计数 +1
  const reply = await b.overlay('蓝毛小女仆：吃饭啦', { session: 'pet' });
  assert.equal(reply, 'OK');
  assert.equal(b.pushCount, 1);
  const last = calls[calls.length - 1];
  assert.equal(last.path, '/app/overlay');
  assert.equal(last.q.text, '蓝毛小女仆：吃饭啦');
  assert.equal(last.q.session, 'pet');
  assert.equal(last.q.kind, 'text');

  // 4) 同一行 6 秒内不再重复推（悬浮条按"整行"显示，重复推只会闪）
  assert.equal(await b.overlay('蓝毛小女仆：吃饭啦'), '', '相同内容必须去重');
  // force 可以越过去重
  assert.equal(await b.overlay('蓝毛小女仆：吃饭啦', { force: true }), 'OK');
}

// 5) 用户关掉悬浮条 → DISABLED → 进冷却，后续不再请求
{
  const b = new DshaBridge({ base, dshHome: home });
  await b.probe();
  overlayMode = 'disabled';
  const before = calls.length;
  assert.equal(await b.overlay('第一行'), 'DISABLED');
  assert.equal(b.usable, false, 'DISABLED 后必须进冷却');
  assert.equal(await b.overlay('第二行'), '', '冷却期内不再发请求');
  assert.equal(calls.length, before + 1, '冷却期确实没有再敲桥');
  overlayMode = 'ok';
}

// 6) 没授权 → NO_PERMISSION 同样冷却（权限归宿主，插件只等）
{
  const b = new DshaBridge({ base, dshHome: home });
  await b.probe();
  overlayMode = 'no-permission';
  assert.equal(await b.overlay('任意'), 'NO_PERMISSION');
  assert.equal(b.usable, false);
  overlayMode = 'ok';
}

// 7) .bridge_headers 也能取到 token（DSHA 给 curl -H @file 的那份）
{
  const alt = mkdtempSync(join(tmpdir(), 'dsha-headers-'));
  writeFileSync(join(alt, '.bridge_headers'), 'X-Token: ' + TOKEN + '\n', 'utf8');
  const b = new DshaBridge({ base, dshHome: alt });
  assert.equal(await b.probe(), true);
  rmSync(alt, { recursive: true, force: true });
}

server.close();
rmSync(home, { recursive: true, force: true });
console.log('✓ dsha: 全部通过');
