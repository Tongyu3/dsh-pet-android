/**
 * 本地验收服务器（开发用，不随插件分发）。
 *
 * 一个进程同时扮演两个角色：
 *   · 本插件（/dsh-pet-android/*）：用最小 ctx 直接调 apply()，路由与生产一致；
 *   · 上游 dsh-pet（/dsh-pet-7340/*）：只实现本页面用到的三条路由 + 一份最小配置。
 *     这里**不复制上游任何源码**，配置与素材都是本文件手写的等价替身。
 *
 * 跑法：node test/preview-server.mjs [端口]
 * 素材：页面要靠真 webm 才能看到宠物，但上游素材**不随本仓库分发**，请自己放一段：
 *   test/fixtures/idle.webm   （从你已安装的 dsh-pet 的 assets/webm/ 里任取一个改名即可）
 * 然后浏览器打开：http://127.0.0.1:<端口>/dsh-pet-android/overlay.html?preview=1&pet=main
 *   —— preview=1 时宠物在页面内用 transform 摆位，不需要宿主窗口，用于肉眼验收。
 */
import { createServer } from 'node:http';
import { createReadStream, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-pet-android-preview-'));
process.env.DSH_PET_ANDROID_DIR = join(process.env.DSH_HOME, 'channel');

const { apply } = await import('../src/index.js');

const routes = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  webServer: { port: 0, register: (reg) => (routes.push(reg), () => {}) },
  effect(fn) {
    fn();
    return () => {};
  },
};
apply(ctx);

/** 上游配置的最小等价替身：字段名/语义与上游一致，内容是本仓库自己的 */
const CONFIG = {
  main: {
    pets: [
      {
        name: '验收宠物',
        id: 'main',
        size: 462,
        display: 'both',
        position: { corner: 'top-right', marginX: 24, marginY: 100 },
        animations: {
          idle: ['待机呼吸休闲'],
          turn: ['东张西望'],
          drag: ['被鼠标拖拽悬空反馈'],
          clicks: ['点击回应-元气挥手'],
          moves: { default: { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 }, actions: [{ name: '原地漂浮踏步' }] },
          categories: [{ id: '小动作', weight: 20, actions: ['哈欠连天', '照镜子'] }],
        },
        physics: { gravity: 1400, restitution: 0.78, groundFriction: 2.5, throwPower: 1 },
      },
    ],
  },
};

const STATE = { sections: {}, pets: {}, configVersion: 1 };
const ASSET = new URL('./fixtures/idle.webm', import.meta.url);

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  if (path.startsWith('/dsh-pet-android')) return routes[0].handler(req, res);

  if (path === '/dsh-pet-7340/config') {
    const body = JSON.stringify(CONFIG);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    return res.end(body);
  }
  if (path === '/dsh-pet-7340/state') {
    const body = JSON.stringify({ ...STATE, configVersion: STATE.configVersion });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    return res.end(body);
  }
  if (path.startsWith('/dsh-pet-7340/thumb/')) {
    // 任何动画名都回同一段素材：验收看的是"能不能播、能不能拖"，不是素材库
    const size = statSync(ASSET).size;
    res.writeHead(200, { 'content-type': 'video/webm', 'content-length': size, 'cache-control': 'no-cache' });
    return createReadStream(ASSET).pipe(res);
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('preview: not found');
});

const port = Number(process.argv[2] || 0);
server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  // 端口就绪后再让插件拿到它（生产里 ctx.webServer.port 同样是稍后才可用的）
  ctx.webServer.port = actual;
  console.log(`preview server: http://127.0.0.1:${actual}/`);
  console.log(`overlay:        http://127.0.0.1:${actual}/dsh-pet-android/overlay.html?preview=1&pet=main`);
  console.log(`panel:          http://127.0.0.1:${actual}/dsh-pet-android/`);
});
