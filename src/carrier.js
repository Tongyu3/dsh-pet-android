/**
 * 宿主通道（host contract v1）—— 插件与 Android 宿主之间**唯一**的窗口生命周期接口。
 *
 * 边界（写死在这里，别在别处松口）：
 *   · 插件只做两件事：写请求文件、伺服渲染页面。
 *   · 窗口的创建、层级、触摸、以及 SYSTEM_ALERT_WINDOW 权限申请全在宿主任内 ——
 *     插件不检测、不引导、不兜底权限。权限没给，宿主不建窗，这里只会留下"没人读"的请求文件。
 *   · 通道是**文件**而不是 HTTP：容器里的 Node 进程没有 Android Context，也拿不到 Binder；
 *     而 DSH 安卓版本来就用 /sdcard/.dsh-phone 下的文件做双向通信（hud.json）。
 *
 * 请求文件 pet-overlay.json（插件写、宿主读）：
 *   { v:1, gen:12, ts:..., enabled:true, baseUrl:"http://127.0.0.1:3080/dsh-pet-android/overlay.html",
 *     windows:[ { id:"auto", url:"<baseUrl>?pet=auto", anchor, marginX, marginY,
 *                 x?:number, y?:number } ] }
 *
 * 应答文件 pet-overlay.state.json（宿主写、插件读）：
 *   { v:1, gen:12, applied:true, error:null, ts:...,
 *     screen:{ w:1080, h:2400, top:72, bottom:84, density:3 },
 *     windows:[ { id:"auto", x:800, y:300, w:462, h:560 } ] }
 *
 * 语义：
 *   · gen 单调递增；宿主只处理比自己记住的更大的 gen，重复读同一份是幂等的。
 *   · windows 是**全量快照**：没出现在列表里的 id 必须被宿主关闭。
 *   · enabled:false 时 windows 为空数组 —— 等价于"全部关闭"，插件侧不做任何窗口操作。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROTOCOL_VERSION = 1;

/** 一次性封装「读目录 + 写请求 + 读应答」，生命周期内只 new 一次 */
export class HostChannel {
  constructor(dir, logger) {
    this.dir = dir;
    this.logger = logger;
    this.gen = 0;
    this.lastWritten = '';
    this.requestFile = join(dir, 'pet-overlay.json');
    this.stateFile = join(dir, 'pet-overlay.state.json');
    this.lastError = null;
  }

  /**
   * 发布一份全量快照。内容没变就不写盘（宿主按 gen 处理，重复写只会让它白忙）。
   * @returns {{written:boolean, gen:number, error:string|null}}
   */
  publish(snapshot) {
    const body = {
      v: PROTOCOL_VERSION,
      gen: this.gen + 1,
      ts: Date.now(),
      enabled: snapshot.enabled !== false,
      baseUrl: snapshot.baseUrl || '',
      windows: Array.isArray(snapshot.windows) ? snapshot.windows : [],
    };
    const json = JSON.stringify(body, null, 2) + '\n';
    if (json === this.lastWritten) return { written: false, gen: body.gen, error: null };
    try {
      mkdirSync(this.dir, { recursive: true });
      // 先写临时文件再 rename：宿主任何时刻读到的都是完整 JSON，不会读到半截
      const tmp = this.requestFile + '.tmp';
      writeFileSync(tmp, json, 'utf8');
      renameSync(tmp, this.requestFile);
      this.gen = body.gen;
      this.lastWritten = json;
      this.lastError = null;
      return { written: true, gen: body.gen, error: null };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.logger?.warn?.(`[dsh-pet-android] 发布悬浮窗请求失败：${this.lastError}`);
      return { written: false, gen: this.gen, error: this.lastError };
    }
  }

  /** 读宿主的应答（不存在/损坏都当"还没有"处理，永远不抛） */
  readState() {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      return raw;
    } catch {
      return null;
    }
  }
}
