/**
 * DSHA 适配器 —— 对接 DSHA（com.dsh.client）的 3090 设备/交互桥。
 *
 * 事实来源（均已读源码核对，不是猜的）：
 *   · 桥监听 127.0.0.1:3090，鉴权头 `X-Token`，token 由宿主写到 /root/.dsh/.bridge_token，
 *     同时在 /root/.dsh/.bridge_headers 提供 `curl -H @file` 形式（HttpShellService 顶部注释）。
 *   · 悬浮条端点 /app/overlay?kind=&text=&session= → 返回 DISABLED / NO_PERMISSION /
 *     SKIP_REASONING / OK / OK_NO_CMD（HttpShellService.appOverlay）。
 *   · /app/version 返回 BRIDGE_PROTOCOL=… APP_VERSION=… APP_CODE=…，是用来做特性检测的。
 *   · 悬浮条本身是 TYPE_APPLICATION_OVERLAY 的自绘窗口，**权限与开关由 DSHA 负责**
 *     （OverlayController.permitted / enabled），所以本适配器只判断"能不能用"，
 *     绝不申请权限、绝不跳系统设置。
 *
 * 为什么 DSHA 上只有文本：它的 3090 桥不提供 WebView/图片悬浮窗端点，插件可用的
 * 系统级表面只有这条文本悬浮条。想要完整宠物窗口，得由宿主演进到契约 v1（见
 * docs/HOST-CONTRACT.md）；在那之前，DSHA 上宠物以"在场文本"的形式存在于屏幕顶部。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 1500;
const COOLDOWN_MS = 60_000;
const PROBE_RETRY_MS = 30_000;

/**
 * 解析 `{"result":"OK"}` 这类统一包装；不是 JSON 就原样返回。
 * 307 行的坑在上游 dsh-status-overlay 里踩过：直接拿整段 body 做等值比较永远不成立，
 * 于是"没开悬浮条时的冷却"从没生效过，白敲一晚上的 HTTP。
 */
function unwrap(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  try {
    const j = JSON.parse(s);
    if (j && typeof j.result === 'string') return j.result.trim();
  } catch {
    /* 纯文本响应 */
  }
  return s;
}

/** token 候选路径：不同移植/不同版本的 DSH_HOME 不一样，全都试一遍再放弃 */
function tokenCandidates(dshHome) {
  const home = dshHome || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh');
  return [
    process.env.DSH_PET_ANDROID_TOKEN,
    process.env.DSH_BRIDGE_TOKEN,
    join(home, '.bridge_token'),
    '/root/.dsh/.bridge_token',
    join(home, '.bridge_headers'),
    '/root/.dsh/.bridge_headers',
  ].filter(Boolean);
}

export class DshaBridge {
  /**
   * @param {{base?:string, dshHome?:string, tokenPath?:string, logger?:{warn?:Function,info?:Function}}} opts
   */
  constructor(opts = {}) {
    this.base = (opts.base || process.env.DSH_PET_ANDROID_DSHA_BASE || 'http://127.0.0.1:3090').replace(/\/+$/, '');
    this.dshHome = opts.dshHome || '';
    this.tokenPath = opts.tokenPath || '';
    this.logger = opts.logger;
    this.timeoutMs = Number(opts.timeoutMs) || TIMEOUT_MS;

    this.token = '';
    this.tokenSource = '';
    this.detected = false;
    this.version = null;
    this.error = null;
    this.lastProbe = 0;
    this.cooldownUntil = 0;
    this.lastText = '';
    this.lastPushAt = 0;
    this.pushCount = 0;
    this.lastResponse = '';
  }

  /** 读 token（一次读不到就每轮重新试：桥/容器是先后起来的，顺序不保证） */
  readToken() {
    if (this.token) return this.token;
    const list = this.tokenPath ? [this.tokenPath, ...tokenCandidates(this.dshHome)] : tokenCandidates(this.dshHome);
    for (const p of list) {
      try {
        if (!existsSync(p)) continue;
        const raw = readFileSync(p, 'utf8');
        if (p.endsWith('.bridge_token')) {
          const t = raw.trim();
          if (t) {
            this.token = t;
            this.tokenSource = p;
            return t;
          }
        } else {
          // .bridge_headers 的格式是 curl 头文件：`X-Token: xxx` 或 `x-token: xxx`
          const m = raw.match(/^\s*X-Token\s*:\s*(\S+)\s*$/im);
          if (m) {
            this.token = m[1];
            this.tokenSource = p;
            return this.token;
          }
        }
      } catch {
        /* 权限/不存在：继续试下一个 */
      }
    }
    return '';
  }

  /** 带上 X-Token 的 GET；超时即放弃（桥就在本机，1.5 秒等不到就是没起） */
  async get(path) {
    const token = this.readToken();
    if (!token) return { ok: false, body: '', error: 'no-token' };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.base + path, {
        headers: { 'X-Token': token },
        signal: ac.signal,
      });
      const body = unwrap(await res.text());
      return { ok: res.ok, body, error: res.ok ? null : `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, body: '', error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 探测：没有 token → 不是 DSHA（或桥没起）；有 token 但 /app/version 不通 → 报错。
   * 30 秒内不重复探测，避免每 1.2 秒一轮地敲一个不存在的端口。
   */
  async probe(now = Date.now()) {
    if (now - this.lastProbe < PROBE_RETRY_MS) return this.detected;
    this.lastProbe = now;
    if (!this.readToken()) {
      this.detected = false;
      this.error = 'no-token';
      return false;
    }
    const r = await this.get('/app/version');
    if (!r.ok) {
      this.detected = false;
      this.error = r.error || 'version-failed';
      return false;
    }
    this.detected = true;
    this.error = null;
    const m = r.body.match(/APP_VERSION=([^\s]+)/);
    this.version = m ? m[1] : 'unknown';
    return true;
  }

  /** 现在能不能往悬浮条推（探测过、没在冷却、有 token） */
  get usable() {
    return this.detected && Date.now() >= this.cooldownUntil && Boolean(this.token);
  }

  /**
   * 推一行到悬浮条。返回宿主原话（OK / DISABLED / NO_PERMISSION / …），失败返回空串。
   * 内容没变就不推：悬浮条是"当前应显示的整行"，重复推同一行纯属烧电。
   */
  async overlay(text, { kind = 'text', session = 'pet', force = false } = {}) {
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (!line) return '';
    if (!this.usable) return '';
    const now = Date.now();
    if (!force && line === this.lastText && now - this.lastPushAt < 6000) return '';
    if (!force && now - this.lastPushAt < 400) return ''; // 节流：DSHA 悬浮条按行渲染，推太快只会闪
    const q =
      `?kind=${encodeURIComponent(kind)}` +
      `&session=${encodeURIComponent(session)}` +
      `&text=${encodeURIComponent(line)}`;
    const r = await this.get('/app/overlay' + q);
    this.lastPushAt = now;
    this.lastResponse = r.body || r.error || '';
    if (!r.ok) return '';
    if (r.body === 'DISABLED' || r.body === 'NO_PERMISSION') {
      // 用户没开或没授权：进冷却，别对着关着的门一直敲（权限归宿主，插件只等）
      this.cooldownUntil = now + COOLDOWN_MS;
      return r.body;
    }
    if (r.body.startsWith('OK')) {
      this.lastText = line;
      this.pushCount += 1;
    }
    return r.body;
  }

  /** 清屏（插件关闭/卸载时让悬浮条别留着上一行字） */
  async clear(session = 'pet') {
    if (!this.detected) return '';
    return this.overlay('', { kind: 'clear', session, force: true });
  }

  /** 其余 DSHA 能力：宠物事件用得上，但都不是必需的 */
  notify(title, text) {
    return this.get(`/app/notify?title=${encodeURIComponent(title)}&text=${encodeURIComponent(text)}`);
  }

  vibrate(ms = 120) {
    return this.get(`/app/vibrate?ms=${Math.max(1, Math.min(5000, ms))}`);
  }

  toast(text) {
    return this.get(`/app/toast?text=${encodeURIComponent(text)}`);
  }

  status() {
    return {
      kind: 'dsha-3090',
      base: this.base,
      detected: this.detected,
      usable: this.usable,
      tokenSource: this.tokenSource || null,
      version: this.version,
      error: this.error,
      cooldownMs: Math.max(0, this.cooldownUntil - Date.now()),
      lastResponse: this.lastResponse || null,
      pushCount: this.pushCount,
    };
  }
}
