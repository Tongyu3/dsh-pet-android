/**
 * 冒烟测试 —— 不依赖 DSH，用最小 ctx + 真 HTTP 服务器把插件跑起来。
 *
 * 覆盖：路由注册、状态、静态页、hello 多宠物开窗、开关、设置落盘、通道请求文件、路径穿越拒绝。
 * 跑法：node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-pet-android-'));
process.env.DSH_HOME = home;
process.env.DSH_PET_ANDROID_DIR = join(home, 'channel');

const { apply, name, inject } = await import('../src/index.js');

assert.equal(name, 'dsh-pet-android', 'name 必须与 cordis.patch.yml 的 id 一致');
assert.deepEqual(inject, ['webServer'], '只注入 webServer');

const disposers = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  webServer: {
    port: 0,
    register(reg) {
      assert.equal(reg.kind, 'prefix');
      assert.equal(reg.path, '/dsh-pet-android');
      routes.push(reg);
      return () => {};
    },
  },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return () => {};
  },
};

const routes = [];
apply(ctx);

const server = createServer((req, res) => {
  const reg = routes[0];
  reg.handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
ctx.webServer.port = port;

const base = `http://127.0.0.1:${port}`;
const get = (path) => fetch(base + path);
const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 等同步循环把首份快照写出来（syncMs 默认 2000，首轮立即跑，但端口当时还是 0）
await new Promise((r) => setTimeout(r, 2300));

// 1. 状态
const status = await (await get('/dsh-pet-android/status')).json();
assert.equal(status.ok, true);
assert.equal(status.enabled, true);
assert.ok(status.baseUrl.includes('/dsh-pet-android/overlay.html'), 'baseUrl 必须指向 overlay.html');
assert.ok(status.channel.requestFile.endsWith('pet-overlay.json'));

// 2. 请求文件：还没有页面上报时，应当有且只有一个 auto 窗口
const reqFile = status.channel.requestFile;
assert.ok(existsSync(reqFile), '请求文件必须已落盘');
let snapshot = JSON.parse(readFileSync(reqFile, 'utf8'));
assert.equal(snapshot.v, 1);
assert.equal(snapshot.windows.length, 1);
assert.equal(snapshot.windows[0].id, 'auto');
assert.ok(snapshot.windows[0].url.includes('?pet=auto'));

// 3. 静态资源
const html = await get('/dsh-pet-android/overlay.html');
assert.equal(html.status, 200);
assert.match(html.headers.get('content-type') || '', /text\/html/);
const page = await html.text();
assert.match(page, /overlay\.js/);
assert.match(page, /overlay\.css/);
const js = await get('/dsh-pet-android/overlay.js');
assert.equal(js.status, 200);
assert.match(js.headers.get('content-type') || '', /javascript/);
const css = await get('/dsh-pet-android/overlay.css');
assert.equal(css.status, 200);
const panel = await get('/dsh-pet-android/');
assert.equal(panel.status, 200);
assert.match(await panel.text(), /dsh-pet-android/);

// 4. 页面上报：多宠物 → 补第二个窗口
const hello = await (await post('/dsh-pet-android/hello', {
  win: 'auto',
  pet: 'main',
  size: 462,
  anchor: 'top-right',
  marginX: 24,
  marginY: 100,
  pets: [{ id: 'main', anchor: 'top-right' }, { id: 'alt', anchor: 'bottom-left', marginX: 12, marginY: 12 }],
})).json();
assert.equal(hello.ok, true);
snapshot = JSON.parse(readFileSync(reqFile, 'utf8'));
assert.equal(snapshot.windows.length, 2, '两只宠物 = 两个窗口');
const alt = snapshot.windows.find((w) => w.id === 'pet:alt');
assert.ok(alt, '缺少 pet:alt 窗口');
assert.equal(alt.anchor, 'bottom-left');
assert.ok(alt.url.includes('pet=alt'));

// 5. 位置回退上报（无 JS 桥时走这条）
const pointer = await (await post('/dsh-pet-android/pointer', { win: 'auto', x: 120, y: 340 })).json();
assert.equal(pointer.ok, true);
snapshot = JSON.parse(readFileSync(reqFile, 'utf8'));
const autoWin = snapshot.windows.find((w) => w.id === 'auto');
assert.equal(autoWin.x, 120);
assert.equal(autoWin.y, 340);

// 6. 设置：同步间隔 + 开关
const save = await (await post('/dsh-pet-android/settings', { syncMs: 1500, marginX: 8 })).json();
assert.equal(save.ok, true);
assert.equal(save.settings.syncMs, 1500);
assert.equal(save.settings.marginX, 8);
assert.ok(existsSync(join(home, 'dsh-pet-android', 'settings.json')));

const off = await (await post('/dsh-pet-android/enable', { on: false })).json();
assert.equal(off.settings.enabled, false);
snapshot = JSON.parse(readFileSync(reqFile, 'utf8'));
assert.equal(snapshot.enabled, false);
assert.equal(snapshot.windows.length, 0, '关闭后必须发一份空窗口快照，宿主据此收窗');

// 7. 路径穿越与未知路由
const evil = await get('/dsh-pet-android/overlay.html%2f..%2f..%2fpackage.json');
assert.equal(evil.status, 404);
const nope = await get('/dsh-pet-android/nope');
assert.equal(nope.status, 404);

// 8. 卸载阶段：发 enabled:false，不留窗口
for (const dispose of disposers) dispose();
snapshot = JSON.parse(readFileSync(reqFile, 'utf8'));
assert.equal(snapshot.windows.length, 0);

server.close();
rmSync(home, { recursive: true, force: true });
console.log('✓ smoke: 全部通过');
