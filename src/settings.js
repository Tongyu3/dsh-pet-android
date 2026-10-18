/**
 * 插件设置 —— 只有「要不要显示、节奏、通道目录覆盖」这类插件自己的开关。
 *
 * 宠物的 size / display / position / animations / physics 一律**不在这里**：
 * 那是上游 dsh-pet 的配置（/dsh-pet-7340/config），本插件在页面侧直接拉上游那份，
 * 保证同一条配置在「dsh 内」与「Android 上层」两种显示形式下语义一致，不产生第二份真相。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pluginStateDir } from './paths.js';

/** 默认值（写错/缺失都回落到这里，绝不因为一个字段让整个插件不启动） */
export const DEFAULTS = Object.freeze({
  /** 总开关：false = 立即让宿主关掉所有宠物窗口（保留插件、配置不动） */
  enabled: true,
  /** 宿主请求文件的轮询/重发间隔（宿主自己没有推送通道，只能由它有节奏地来读） */
  syncMs: 2000,
  /** 首次没有屏幕信息时的锚点（宠物自己配置的 position 落地后会覆盖它） */
  anchor: 'top-right',
  marginX: 24,
  marginY: 100,
  /** 覆盖请求文件里的页面地址（默认用 DSH WebServer 的 127.0.0.1:<port>） */
  baseUrl: '',
  /** 调试日志：把每次发布/应答写进插件日志 */
  debug: false,
  /**
   * 文本悬浮条（DSHA 等「只给插件开放文本悬浮层」的移植用）。
   *   auto = 窗口载体没落地时才用（默认；DSHA 上就是这条路）
   *   on   = 始终用（窗口也在时当状态提示）
   *   off  = 完全不用
   */
  statusOverlay: 'auto',
  /** DSHA 3090 桥地址覆盖（默认 http://127.0.0.1:3090） */
  dshaBase: '',
  /** DSHA token 路径覆盖（默认自动找 .bridge_token / .bridge_headers） */
  dshaTokenPath: '',
});

const FILE = 'settings.json';

/** 设置文件绝对路径 */
export function settingsPath() {
  return join(pluginStateDir(), FILE);
}

/** 只接受已知键，且类型不对就当没写（不抛错） */
function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (Number.isFinite(raw.syncMs)) out.syncMs = Math.min(10000, Math.max(500, Math.round(raw.syncMs)));
  if (typeof raw.anchor === 'string' && ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(raw.anchor)) {
    out.anchor = raw.anchor;
  }
  if (Number.isFinite(raw.marginX)) out.marginX = Math.max(0, Math.round(raw.marginX));
  if (Number.isFinite(raw.marginY)) out.marginY = Math.max(0, Math.round(raw.marginY));
  if (typeof raw.baseUrl === 'string') out.baseUrl = raw.baseUrl.trim();
  if (typeof raw.debug === 'boolean') out.debug = raw.debug;
  if (['auto', 'on', 'off'].includes(raw.statusOverlay)) out.statusOverlay = raw.statusOverlay;
  if (typeof raw.dshaBase === 'string') out.dshaBase = raw.dshaBase.trim();
  if (typeof raw.dshaTokenPath === 'string') out.dshaTokenPath = raw.dshaTokenPath.trim();
  return out;
}

/** 读取设置（文件不存在 = 默认值；损坏 = 默认值 + 不覆盖用户文件） */
export function loadSettings() {
  try {
    return sanitize(JSON.parse(readFileSync(settingsPath(), 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

/** 保存设置（只落已知键；建目录失败时抛给调用方，让 HTTP 响应带上真实原因） */
export function saveSettings(patch) {
  const next = sanitize({ ...loadSettings(), ...patch });
  const file = settingsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}
