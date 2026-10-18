/**
 * DSHA 路径的端到端测试 —— 插件 → 3090 悬浮条，不需要真机。
 *
 * 一个进程里同时假扮三方：
 *   · DSH WebServer（挂本插件路由 + 上游 /dsh-pet-7340/state|config）
 *   · DSHA 的 3090 桥（/app/version、/app/overlay）
 *   · 宿主不实现窗口契约（没有 pet-overlay.state.json）→ 插件必须自动走悬浮条
 *
 * 断言的核心事实：宿主不给窗口时，宠物的话真的会出现在系统悬浮条上。
 * 跑法：node test/status-overlay.test.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'e2e-bridge-token';
const home = mkdtempSync(join(tmpdir(), 'dsh-pet-android-e2e-'));
process.env.DSH_HOME = home;
process.env.DSH_PET_ANDROID_DIR = join(home, 'channel');
writeFileSync(join(home, '.bridge_token'), TOKEN + '\n', 'utf8');

const overlayCalls = [];
let stateCounter = 7;

// ---- 假 DSHA 3090 桥 ----
const dsha = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.headers['x-token'] !== TOKEN) {
    res.writeHead(403);
    return res.end('{"result":"UNAUTHORIZED"}');
  }
  if (url.pathname === '/app/version') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('BRIDGE_PROTOCOL=4\nAPP_VERSION=0.2.24\nAPP_CODE=173\n');
  }
  if (url.pathname === '/app/overlay') {
    overlayCalls.push({ text: url.searchParams.get('text'), kind: url.searchParams.get('kind') });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"result":"OK"}');
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => dsha.listen(0, '127.0.0.1', r));
process.env.DSH_PET_ANDROID_DSHA_BASE = `http://127.0.0.1:${dsha.address().port}`;

// ---- 插件 + 假上游 ----
const { apply } = await import('../src/index.js');
const routes = [];
const disposers = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  webServer: { port: 0, register: (reg) => (routes.push(reg), () => {}) },
  effect(fn) {
    const d = fn();
    if (typeof d === 'function') disposers.push(d);
    return () => {};
  },
};
apply(ctx);

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/dsh-pet-android')) return routes[0].handler(req, res);
  if (url.pathname === '/dsh-pet-7340/state') {
    const body = JSON.stringify({
      sections: {},
      pets: { main: { say: { counter: stateCounter, data: { text: '吃饭啦' } } } },
      configVersion: 1,
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    return res.end(body);
  }
  if (url.pathname === '/dsh-pet-7340/config') {
    const body = JSON.stringify({ main: { pets: [{ id: 'main', name: '蓝毛小女仆', display: 'both' }] } });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    return res.end(body);
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
ctx.webServer.port = server.address().port;
const base = `http://127.0.0.1:${server.address().port}`;

// 插件每 1.2 秒一轮；等它跑两轮（首轮探测 + 取状态，次轮推文）
await new Promise((r) => setTimeout(r, 3200));

assert.ok(overlayCalls.length >= 1, '窗口载体不存在时，DSHA 悬浮条必须收到推送');
const first = overlayCalls.find((c) => (c.text || '').includes('吃饭啦'));
assert.ok(first, `悬浮条内容必须带宠物那句话，实际：${JSON.stringify(overlayCalls)}`);
assert.equal(first.text, '蓝毛小女仆：吃饭啦', '格式应为「名字：内容」');
assert.equal(first.kind, 'text');

// 状态里能看出走的是哪条载体
const status = await (await fetch(`${base}/dsh-pet-android/status`)).json();
assert.equal(status.carriers.statusOverlay.detected, true);
assert.equal(status.carriers.statusOverlay.usable, true);
assert.ok(status.carriers.statusOverlay.pushCount >= 1);
assert.equal(status.carriers.window.applied, false, '假宿主没实现窗口契约');

// 内容不变不重复推
const pushes = overlayCalls.length;
await new Promise((r) => setTimeout(r, 1600));
assert.equal(overlayCalls.length, pushes, '同一句话不该重复推');

// 换一句话 → 必须再推一次
stateCounter += 1;
await new Promise((r) => setTimeout(r, 2600));
assert.ok(overlayCalls.length > pushes, '内容变化后必须重新推');

for (const d of disposers) d(); // 停掉插件的两个定时器，进程才能退出
server.close();
dsha.close();
rmSync(home, { recursive: true, force: true });
console.log('✓ status-overlay: 全部通过');
