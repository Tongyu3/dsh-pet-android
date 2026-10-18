/**
 * dsh-pet-android —— 宿主半侧入口（Cordis 插件）。
 *
 * 一句话：上游 dsh-pet 负责「宠物是什么」，本插件负责「把它的桌面窗口换成 Android 上层窗口」。
 *
 * 路由（前缀 /dsh-pet-android，注册在 DSH WebServer 上，与上游 /dsh-pet-7340 同源同端口）：
 *   GET  /dsh-pet-android/                控制面板（开关 + 状态，浏览器可直接打开）
 *   GET  /dsh-pet-android/overlay.html    → 宿主悬浮窗里加载的宠物页面（透明底）
 *   GET  /dsh-pet-android/overlay.js|css  页面资源
 *   GET  /dsh-pet-android/status          { 设置, 通道, 宿主应答, 屏幕, 窗口 } 全量状态
 *   POST /dsh-pet-android/settings        { enabled?, syncMs?, anchor?, marginX?, marginY?, debug? }
 *   POST /dsh-pet-android/enable          { on:boolean }（= settings 的快捷方式）
 *   POST /dsh-pet-android/hello           页面首帧上报 { win, pet, size, anchor, marginX, marginY, pets[] }
 *   POST /dsh-pet-android/pointer         无 JS 桥时的高频回退上报 { win, x, y }
 *   POST /dsh-pet-android/report          页面侧观测 { upstreamOk, error }
 *
 * 为什么宠物配置不在宿主半侧读：
 *   上游 /dsh-pet-7340/config 的合并逻辑（内置默认 + 用户层 + 种类文件）是上游的领域知识，
 *   在插件里再实现一遍必然分叉。页面与上游路由**同源**，直接在页面 fetch 上游那份配置，
 *   于是「dsh 内」与「Android 上层」读的是同一份成品配置。
 *
 * 权限：本文件里没有任何权限判断、没有 Settings.canDrawOverlays、没有引导跳转。
 *   悬浮权限归宿主/启动器，插件写完请求文件就结束。
 */
import { createReadStream, existsSync, fstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostChannel } from './carrier.js';
import { overlayChannelDir, pluginStateDir } from './paths.js';
import { loadSettings, saveSettings, settingsPath } from './settings.js';

/** 行标识：必须与 cordis.patch.yml 的 id 一致 */
export const name = 'dsh-pet-android';

/** 只需要 WebServer（路由）；上游的其它服务一个都不碰 */
export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-pet-android';
const VERSION = '0.1.0';

const OVERLAY_ROOT = fileURLToPath(new URL('./overlay/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/** 防穿越：只允许 overlay 静态根下的实体 */
function resolveStatic(rel) {
  if (!rel) return undefined;
  const root = normalize(OVERLAY_ROOT);
  const file = normalize(join(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (file !== root && !file.startsWith(rootWithSep)) return undefined;
  return file;
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // 状态必须实时：被中间层缓存住的话，开关点了不动、gen 永远不涨，现象最难查
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendText(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendFile(res, file) {
  const ext = file.slice(file.lastIndexOf('.'));
  const stream = createReadStream(file);
  stream.once('open', (fd) => {
    if (res.destroyed || res.writableEnded) {
      stream.destroy();
      return;
    }
    try {
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        // 长度取自正在读的这个 fd（先 stat 再开流会因为文件被替换而声明的长度对不上，响应永不结束）
        'content-length': fstatSync(fd).size,
        'cache-control': 'no-cache',
      });
    } catch {
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    }
    stream.pipe(res);
  });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return '';
  return Buffer.concat(chunks).toString('utf8');
}

/** 从 ctx 里拿端口：OS 分配端口时短暂为 0，所以由调用方在同步循环里重试 */
function resolvePort(ctx, settings) {
  if (typeof ctx.webServer?.port === 'number' && ctx.webServer.port > 0) return ctx.webServer.port;
  if (settings.baseUrl) {
    try {
      const u = new URL(settings.baseUrl);
      if (u.port) return Number(u.port);
      return u.protocol === 'https:' ? 443 : 80;
    } catch {
      /* 配置写错：按未就绪处理，等 ctx.webServer.port */
    }
  }
  return 0;
}

export function apply(ctx) {
  let settings = loadSettings();
  const logger = ctx.logger ?? console;
  const channel = new HostChannel(overlayChannelDir(), logger);

  /** 窗口表：id → 窗口快照。页面上报后由宿主按 gen 增量应用 */
  const wins = new Map();
  /** 页面侧观测（上游是否可达等），只用于 /status 展示 */
  const report = { upstreamOk: null, error: null, at: 0, petsReported: false };
  let lastSync = 0;

  const log = (...args) => {
    if (settings.debug) logger.info?.(...args);
  };

  const overlayUrl = (port) => `http://127.0.0.1:${port}${ROUTE_PREFIX}/overlay.html`;

  /** 组装一份"只够开窗"的全量快照：页面自己会再按宠物配置修正 size/位置 */
  function snapshot(port) {
    const base = settings.baseUrl || (port > 0 ? overlayUrl(port) : '');
    const windows = [];
    if (settings.enabled && base) {
      if (wins.size === 0) {
        windows.push({
          id: 'auto',
          url: `${base}?pet=auto`,
          anchor: settings.anchor,
          marginX: settings.marginX,
          marginY: settings.marginY,
        });
      } else {
        for (const [id, win] of wins) {
          windows.push({
            id,
            url: `${base}?pet=${encodeURIComponent(win.pet || 'auto')}`,
            anchor: win.anchor || settings.anchor,
            marginX: Number.isFinite(win.marginX) ? win.marginX : settings.marginX,
            marginY: Number.isFinite(win.marginY) ? win.marginY : settings.marginY,
            ...(Number.isFinite(win.x) && Number.isFinite(win.y) ? { x: Math.round(win.x), y: Math.round(win.y) } : {}),
          });
        }
      }
    }
    return { enabled: settings.enabled, baseUrl: base, windows };
  }

  function sync(force = false) {
    const port = resolvePort(ctx, settings);
    if (port === 0 && !settings.baseUrl) return; // WebServer 还没监听：下一轮再来
    const snap = snapshot(port);
    const result = channel.publish(snap);
    if (result.written || force) {
      lastSync = Date.now();
      log(`[dsh-pet-android] 发布 gen=${result.gen} windows=${snap.windows.length} → ${channel.requestFile}`);
    }
  }

  /** 应用设置补丁：落盘 → 立即重发快照（开关要立刻生效，不能等下一个 sync 周期） */
  function applySettings(patch) {
    settings = saveSettings(patch);
    sync(true);
    return settings;
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rest = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // ---- 静态页面 ----
    if (method === 'GET' && (rest === '/' || rest === '' || rest === '/control.html')) {
      const panel = resolveStatic('control.html');
      return panel && existsSync(panel) ? sendFile(res, panel) : sendText(res, 404, 'dsh-pet-android: control.html missing');
    }
    if (method === 'GET' && /^\/(overlay\.(?:html|js|css))$/.test(rest)) {
      const file = resolveStatic(rest.slice(1));
      if (!file || !existsSync(file)) return sendText(res, 404, 'dsh-pet-android: asset missing');
      return sendFile(res, file);
    }

    // ---- 状态 ----
    if (rest === '/status' && method === 'GET') {
      const state = channel.readState();
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        enabled: settings.enabled,
        gen: channel.gen,
        settings,
        settingsFile: settingsPath(),
        baseUrl: settings.baseUrl || (resolvePort(ctx, settings) ? overlayUrl(resolvePort(ctx, settings)) : ''),
        channel: {
          dir: overlayChannelDir(),
          pluginDir: pluginStateDir(),
          requestFile: channel.requestFile,
          stateFile: channel.stateFile,
          lastWriteError: channel.lastError,
          written: channel.gen > 0,
        },
        host: state
          ? {
              gen: state.gen ?? null,
              applied: state.applied === true,
              error: state.error ?? null,
              screen: state.screen ?? null,
              windows: Array.isArray(state.windows) ? state.windows : [],
              ts: state.ts ?? null,
            }
          : null,
        windows: [...wins.values()],
        windowReport: report,
        lastSync,
      });
    }

    // ---- 设置 ----
    if (rest === '/settings' && method === 'POST') {
      try {
        return sendJson(res, 200, { ok: true, settings: applySettings(JSON.parse((await readBody(req)) || '{}')) });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (rest === '/enable' && method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const on = body.on !== false;
        return sendJson(res, 200, { ok: true, settings: applySettings({ enabled: on }) });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ---- 页面上报：首帧 ----
    if (rest === '/hello' && method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      }
      const winId = String(body.win || 'auto');
      const pet = String(body.pet || 'auto');
      if (!wins.has(winId)) wins.set(winId, {});
      const win = wins.get(winId);
      // 锚点/边距由宠物自己的配置决定（上游 position 语义），宿主只负责落到屏幕坐标
      if (['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(body.anchor)) win.anchor = body.anchor;
      if (Number.isFinite(body.marginX)) win.marginX = body.marginX;
      if (Number.isFinite(body.marginY)) win.marginY = body.marginY;
      win.pet = pet;
      if (Number.isFinite(body.size)) win.size = body.size;

      // 多宠物：首个页面负责把全部宠物 id 报上来，其余每只补一个窗口（与上游"一宠一窗"一致）
      if (Array.isArray(body.pets) && !report.petsReported) {
        report.petsReported = true;
        for (const p of body.pets) {
          const id = String(p?.id ?? '');
          if (!id) continue;
          const extraId = `pet:${id}`;
          if (extraId === winId || wins.has(extraId)) continue;
          if (pet !== 'auto' && id === pet) continue; // 当前窗口已经显示这只
          wins.set(extraId, {
            pet: id,
            anchor: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(p?.anchor) ? p.anchor : settings.anchor,
            marginX: Number.isFinite(p?.marginX) ? p.marginX : settings.marginX,
            marginY: Number.isFinite(p?.marginY) ? p.marginY : settings.marginY,
          });
        }
      }
      sync(true);
      return sendJson(res, 200, { ok: true, gen: channel.gen });
    }

    // ---- 页面上报：高频位置（没有 JS 桥时的回退通道） ----
    if (rest === '/pointer' && method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      }
      const winId = String(body.win || 'auto');
      const win = wins.get(winId) ?? { pet: 'auto' };
      if (Number.isFinite(body.x) && Number.isFinite(body.y)) {
        win.x = body.x;
        win.y = body.y;
      }
      if (Number.isFinite(body.w)) win.w = body.w;
      if (Number.isFinite(body.h)) win.h = body.h;
      wins.set(winId, win);
      sync(false);
      return sendJson(res, 200, { ok: true });
    }

    // ---- 页面观测（上游可达性 / 渲染错误） ----
    if (rest === '/report' && method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        report.upstreamOk = body.upstreamOk === true;
        report.error = typeof body.error === 'string' ? body.error : null;
        report.at = Date.now();
        if (body.error) logger.warn?.(`[dsh-pet-android] 页面错误：${body.error}`);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      }
    }

    return sendText(res, 404, 'dsh-pet-android: not found');
  }

  // 路由（前缀注册，与上游 dsh-pet 的注册方式一致）
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          handle(req, res).catch((e) => {
            try {
              sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
            } catch {
              /* 响应已结束 */
            }
          });
        },
      }),
    'dsh-pet-android: routes',
  );

  // 同步循环：端口就绪后发布首份快照，其后按 syncMs 重发（宿主是拉取模型，插件没有推送通道）
  ctx.effect(() => {
    sync(true);
    const timer = setInterval(() => sync(false), settings.syncMs);
    // 关闭/卸载插件：发一份 enabled:false 的全量快照，让宿主把窗口收走。
    // 这是**协议内的关闭动作**，不是权限兜底 —— 宿主仍然可以自行决定不关。
    return () => {
      clearInterval(timer);
      try {
        channel.publish({ enabled: false, baseUrl: '', windows: [] });
      } catch {
        /* 退出阶段尽力而为 */
      }
    };
  }, 'dsh-pet-android: host channel sync');

  // 启动痕迹：安卓侧的插件最常见的坑是"装上了但没加载"，留一份可读的注册结果
  try {
    const flag = join(pluginStateDir(), 'loaded.json');
    const body = JSON.stringify(
      { version: VERSION, at: new Date().toISOString(), settings: settingsPath(), channel: overlayChannelDir() },
      null,
      2,
    );
    mkdirSync(pluginStateDir(), { recursive: true });
    writeFileSync(flag, body + '\n', 'utf8');
  } catch (e) {
    logger.warn?.(`[dsh-pet-android] 写启动痕迹失败：${e instanceof Error ? e.message : String(e)}`);
  }

  logger.info?.(`[dsh-pet-android] 已加载 v${VERSION}；通道目录 ${overlayChannelDir()}`);
}
