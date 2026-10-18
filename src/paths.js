/**
 * 路径解析 —— 只算路径，不做任何权限判断。
 *
 * 为什么自己算 $DSH_HOME 而不 import @deepseek-ai/dsh-home-paths：
 * 少一个 peer 依赖就少一个在安卓容器里装不上的理由（容器常常离线），
 * 且算法与上游 helper-process.ts 的 dshHomeDir() 完全一致（DSH_HOME → 用户主目录/.dsh）。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** $DSH_HOME（DSH 主目录） */
export function dshHome() {
  const profile = process.env.DSH_HOME;
  if (profile) return profile;
  const user = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(user, '.dsh');
}

/** 本插件自己的持久化目录（设置、日志） */
export function pluginStateDir() {
  return join(dshHome(), 'dsh-pet-android');
}

/**
 * 与 Android 宿主的**文件通道**目录。
 *
 * 默认 /sdcard/.dsh-phone：DSH 安卓版（Tdsh）里这个目录就是「容器 → App」的既有通道，
 * 原生灵动岛（HudOverlayService）就是每秒读这里的 hud.json，插件写、宿主读，天然单向。
 * 目录不存在（桌面端、或没有共享存储的设备）时退到自己目录下的 host-queue，
 * 请求照样写盘，只是没人读 —— /status 会把这件事讲清楚，不假装成功。
 */
export function overlayChannelDir() {
  const explicit = process.env.DSH_PET_ANDROID_DIR;
  if (explicit) return explicit;
  const shared = '/sdcard/.dsh-phone';
  if (existsSync(shared)) return shared;
  return join(pluginStateDir(), 'host-queue');
}
