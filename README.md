# dsh-pet-android

把 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的「桌面显示」分支改造成 **Android 上层窗口（系统悬浮窗）** 承载的衍生插件。

- 上游：<https://github.com/PC2005-cloud/dsh-pet>（MIT，作者 **PC2005-cloud**）
- 本仓库：该项目的 **Android 上层显示形式的衍生插件**，**不含上游本体代码**
- 权限边界：悬浮权限由 dsh / dsh 安卓启动器负责申请，**本插件不申请、不处理、不兜底任何权限逻辑**
- 形态边界：**只有插件**。没有 APK、没有启动器、没有原生库、没有 dex，不会被编进任何安装包
- 适用范围：**不绑定某一个安卓移植**——载体自动探测。DSHA（`com.dsh.client`）开箱可用（文本悬浮条），
  任何实现了窗口契约的移植（Tdsh 等）出完整桌宠。逐移植现状见 [docs/PORT-MATRIX.md](docs/PORT-MATRIX.md)

---

## 1. 这是什么

上游 dsh-pet 有两条显示分支：

| 分支 | 载体 | 上游实现 |
| --- | --- | --- |
| 显示在 dsh 内 | 页面内 DOM 覆盖层 | `src/client/pet.ts` |
| 显示在桌面 | Electron 透明 `BrowserWindow` | `runtime/electron-helper/*` + `src/host/helper-process.ts` |

Android 上没有 Electron、也不能在容器里 `new BrowserWindow`。本插件把**第二条分支**换了个载体：
窗口从「Electron 透明窗」换成「Android 宿主持有的系统悬浮窗」，其余口径（尺寸公式、角落定位、
动画池、拖拽抛掷、气泡）与上游保持一致。

第一条分支（dsh 内嵌显示）**一行未改**：本插件与上游并存，互不覆盖。

```
┌──────────────── Android 手机 ────────────────┐
│  dsh 安卓版 / 启动器（宿主，持 SYSTEM_ALERT_WINDOW） │
│    ├─ WebView（dsh 界面）          ← 上游「显示在 dsh 内」分支照旧 │
│    └─ 悬浮窗 WebView × N           ← 本插件提供的页面，一只宠物一个窗 │
│           ↑ 加载 http://127.0.0.1:<port>/dsh-pet-android/overlay.html │
│  容器内 Node（dsh 宿主进程）                                  │
│    ├─ 上游 dsh-pet：配置 / 素材 / 碎碎念 / 对话（/dsh-pet-7340/*） │
│    └─ 本插件：路由 /overlay.html + 写 /sdcard/.dsh-phone/pet-overlay.json │
└──────────────────────────────────────────────┘
```

## 2. 开源合规

### 2.1 上游信息（必读）

- 上游项目网址：**<https://github.com/PC2005-cloud/dsh-pet>**
- 原作者版权信息：**Copyright (c) 2026 PC2005-cloud**
- 上游许可证：**MIT License**

### 2.2 本仓库的定位与分发方式

- 本仓库是 **dsh-pet 的衍生作品**，具体形式为「Android 上层显示」衍生插件，
  以 MIT 许可证继承上游的授权与义务。
- **本仓库不含上游本体代码**：不复制、不打包、不重新分发上游的 `src/`、`lib/`、`runtime/`、
  `assets/`（动画 webm、表情包、字体）等任何文件。上游能力由使用者按上游仓库（或 npm 包 `dsh-pet`）
  **自行安装**取得，本插件在运行时通过宿主提供的 `/dsh-pet-7340/*` 路由读取上游的成品配置与素材。
- 因此本仓库的分发物只有：本插件自己的 JS 源码、页面资源、文档与许可证声明。
- 二次分发条款：
  1. 允许在 MIT 条款下自由使用、修改、再分发本插件；
  2. 再分发**必须保留**本仓库 `LICENSE` 中的上游版权声明与 MIT 许可证原文（以及 README 中的上游网址）；
  3. 不得声称本仓库是上游官方作品，也不得把上游作者列为为本插件的作者或背书方；
  4. 若把本插件与上游代码合并分发，合并后的整体仍受 MIT 约束，且必须同时保留两边版权声明；
  5. 上游对本插件**不承担任何责任**（上游未参与本衍生作品的开发与验证），问题请提到本仓库。
- 上游 MIT 许可证原文见 `LICENSE`，并在此原样列出：

```text
MIT License

Copyright (c) 2026 PC2005-cloud

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. 环境与机制

### 3.1 dsh 插件是怎么被加载的

| 半侧 | 加载方式 | 本仓库对应文件 |
| --- | --- | --- |
| 宿主半侧（Node） | 包 `main` 被 dsh 的 Cordis Loader `import()`，`cordis.patch.yml` 把它插进配置树 | `src/index.js`、`cordis.patch.yml` |
| 浏览器半侧（WebView） | 需要 `package.json` 的 `dsh.client` + `window.__ModuleLoader__.load()` 单文件产物 | **本插件没有**：宠物页面是由**宿主悬浮窗自己的 WebView** 加载的普通网页 |

没有浏览器半侧是刻意的：少一个 React/ModuleLoader 依赖面，就少一个在安卓容器里装不上的理由，
而且悬浮窗里的页面本来就不在 dsh 的页面树里。

### 3.2 运行环境

- 宿主半侧跑在 **dsh 宿主进程**（Android 版 = 容器里的 Node），只用 `node:fs`、`node:http`、
  `node:path` 与 `ctx.webServer`，**不依赖任何原生桥**；
- 页面跑在 **宿主悬浮窗里的 WebView**，纯 DOM + `<video>` 播上游的 VP9-alpha webm；
- 插件与宿主之间的窗口生命周期走 **文件通道**：`/sdcard/.dsh-phone/pet-overlay.json`（写）+
  `pet-overlay.state.json`（读）。理由：容器里拿不到 `Context`/Binder，而 DSH 安卓版本来就用这个目录
  做双向通信（原生灵动岛读 `hud.json`）；
- 位置另有可选 JS 桥 `window.DshOverlayHost.moveTo(x, y)`（宿主注入），用于拖动跟手；没有桥就自动
  回退到文件通道（约 100ms 粒度）。

完整契约（含 Kotlin 参考实现）见 [`docs/HOST-CONTRACT.md`](docs/HOST-CONTRACT.md)。

### 3.3 哪些文件属于插件包、哪些属于宿主

| 归属 | 内容 |
| --- | --- |
| **本插件包** | `package.json`、`cordis.patch.yml`、`src/**`（宿主半侧 + overlay 页面）、`docs/**`、`LICENSE`、`README.md` |
| **宿主（dsh 安卓版 / 启动器）** | WebView、悬浮窗创建与销毁、`SYSTEM_ALERT_WINDOW` 权限申请、前台服务、`DshOverlayHost` 桥（可选） |
| **上游 dsh-pet** | 配置合并、素材 webm/表情包/字体、`/dsh-pet-7340/*` 路由、碎碎念与对话 |

## 4. 目录结构

```text
dsh-pet-android/
├── LICENSE                      # 本仓库 MIT + 上游版权与 MIT 原文
├── README.md
├── package.json                 # dsh.bundle.patch 声明；无构建步骤（源码即产物）
├── cordis.patch.yml             # insert id: dsh-pet-android
├── docs/
│   ├── HOST-CONTRACT.md         # 宿主契约 v1（文档，不随包分发逻辑）+ DSHA 现状
│   └── PORT-MATRIX.md           # 各安卓移植的适用矩阵与差在哪一步
├── scripts/
│   └── install.mjs              # 跨移植安装器（自动找 DSH_HOME/profile/bundles）
├── src/
│   ├── index.js                 # 宿主半侧：路由 / 开关 / 通道同步 / 多窗口快照 / 载体选择
│   ├── carrier.js               # 文件通道：原子写请求 + 读宿主应答
│   ├── adapters/dsha.js         # DSHA 3090 桥：文本悬浮条 / notify / vibrate / 特性探测
│   ├── settings.js              # 插件自己的设置（enabled/syncMs/statusOverlay/…）
│   ├── paths.js                 # $DSH_HOME 与通道目录解析
│   └── overlay/
│       ├── control.html         # 控制面板（开关、间隔、锚点、载体状态）
│       ├── overlay.html         # 悬浮窗加载的宠物页面（透明底）
│       ├── overlay.js           # 动画链 / 拖拽抛掷 / 气泡 / 与上游同步
│       └── overlay.css
└── test/
    ├── smoke.mjs                # 宿主半侧 8 组断言
    ├── dsha.test.mjs            # DSHA 适配器单测（token/版本/去重/冷却）
    └── status-overlay.test.mjs  # DSHA 路径端到端（假 3090 桥）
```

## 5. 安装、启用、验证

### 5.1 前置条件

1. 已装任意 dsh 安卓移植（DSHA / Tdsh / 其它），且宿主能访问 `127.0.0.1` 上的 DSH WebServer；
2. 已安装**上游** dsh-pet ≥ 0.3.7（`dsh-pet` 的「显示在 dsh 内」分支可用即可）；
3. 想看到**完整桌宠**还需要宿主实现 [`docs/HOST-CONTRACT.md`](docs/HOST-CONTRACT.md) 的窗口侧；
   只看到"文本在场"（DSHA）或页面预览则不需要。

### 5.2 通用安装器（推荐，任何移植都能用）

插件零依赖、无构建产物，所以不需要 pnpm —— 解包 + 写 bundles 就够：

```sh
# 开发机打包（源码即产物）
cd dsh-pet-android && npm pack          # → dsh-pet-android-0.2.0.tgz

# 容器里执行（node 用 dsh 自带的）
node scripts/install.mjs --list                          # 先看有哪些 profile
node scripts/install.mjs --tgz /path/dsh-pet-android-0.2.0.tgz
node scripts/install.mjs --tgz /path/... --profile web   # 只装某一个 profile
node scripts/install.mjs --source .                      # 直接装源码目录（改代码时用）
node scripts/install.mjs --remove                        # 回滚
```

它会：找 `DSH_HOME`（`--home` / `$DSH_HOME` / `/root/.dsh` / `~/.dsh`）→ 枚举 `profiles/*` →
解到 `<profile>/node_modules/dsh-pet-android` → 把包名写进该 profile 的 `dsh.profile.bundles`（幂等）。

DSHA 的 `DSH_HOME` 是 **`/root/.dsh`**，脚本会自动命中。

### 5.3 手动安装（不想用脚本时）

```sh
PROFILE=/root/.dsh/profiles/web      # 按实际 profile 名替换
mkdir -p "$PROFILE/node_modules/dsh-pet-android"
tar -xzf dsh-pet-android-0.2.0.tgz -C "$PROFILE/node_modules/dsh-pet-android" --strip-components=1
```

然后把包名写进该 profile 的 `package.json`（否则不挂载）：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-pet", "dsh-pet-android"]
    }
  }
}
```

DSHA 也可以在它自己的「插件管理」里从本地包/链接安装（它走 `plugin-transactions` 事务），
装完同样确认 bundles 里有 `dsh-pet-android`。

### 5.4 启用与验证

```sh
# 1) 插件是否被加载（安卓侧最常见的问题是"装上了但没加载"）
cat "$DSH_HOME/dsh-pet-android/loaded.json"

# 2) 载体判定：这台设备上宠物走哪条路
curl -s http://127.0.0.1:3080/dsh-pet-android/status | grep -A20 carriers

# 3) 完整桌宠：请求文件在写、gen 在涨
cat /sdcard/.dsh-phone/pet-overlay.json

# 4) 完整桌宠：宿主应答（applied:true 且 error:null）
cat /sdcard/.dsh-phone/pet-overlay.state.json

# 5) DSHA 文本载体：手动推一行试试（能上屏就说明整条链路通）
curl -s -X POST http://127.0.0.1:3080/dsh-pet-android/statusline \
  -H 'content-type: application/json' -d '{"text":"宠物在线"}'
```

- 打开控制面板：`http://127.0.0.1:3080/dsh-pet-android/`（能看到两条载体的实时状态）
- 只看宠物页面（不建窗）：`http://127.0.0.1:3080/dsh-pet-android/overlay.html?preview=1&pet=auto`
  —— 桌面浏览器里也能跑，是最快的「页面是否正常」验收路径；
- 宠物是否出现，取决于宠物配置里 `display` 是否为 `desktop` 或 `both`
  （上游设置页 → 显示方式 → 桌面 / 两者）。
- **DSHA 上**：宠物的话会出现在顶部文本悬浮条里。前提是用户在 DSHA 里开了悬浮条并给了悬浮窗权限
  （那是 DSHA 自己的开关，插件只读返回值）。返回 `DISABLED` / `NO_PERMISSION` 时插件冷却 60 秒，
  不会反复骚扰。

### 5.5 失败回滚

按代价从小到大：

1. **只关显示**：控制面板点「关闭」，或

   ```sh
   curl -s -X POST http://127.0.0.1:3080/dsh-pet-android/enable \
     -H 'content-type: application/json' -d '{"on":false}'
   ```

   插件会立刻发一份 `enabled:false` 且 `windows:[]` 的快照，宿主据此收窗；插件本身仍在，随时可再开。

2. **改设置文件**：`~/.dsh/dsh-pet-android/settings.json` 里把 `"enabled": true` 改成 `false`，重启 dsh。

3. **从 profile 移除**：

   ```sh
   PROFILE=~/.dsh/profiles/desktop
   cd "$PROFILE"
   node /path/to/pnpm.mjs remove dsh-pet-android
   # 并把 "dsh-pet-android" 从 package.json 的 dsh.profile.bundles 里删掉
   ```

4. **删目录**：

   ```sh
   rm -rf ~/.dsh/profiles/desktop/node_modules/dsh-pet-android
   rm -rf ~/.dsh/dsh-pet-android           # 只删本插件自己的状态
   rm -f /sdcard/.dsh-phone/pet-overlay.json /sdcard/.dsh-phone/pet-overlay.state.json
   ```

   不要删 `~/.dsh/dsh-pet/`：那是上游的配置与素材。

5. 回滚后重启 dsh；若窗口残留（宿主没实现「快照为空即关窗」），手动关闭宿主悬浮窗开关再开一次。

## 6. 注意事项与已知限制

1. **窗口不是插件能造的**。Android 上任何 `WindowManager.addView` 都需要宿主 App 的 Context 与
   `SYSTEM_ALERT_WINDOW`，容器里的 Node 拿不到。所以本插件的成品形态是「页面 + 请求文件 + 载体适配」，
   宿主按契约建窗；DSHA 上则由它自己的文本悬浮条承载。`/status.carriers` 会如实报告走的是哪条。
2. **DSHA 目前只能"文本在场"，不是完整桌宠**。DSHA 的 3090 桥没有 WebView/图片悬浮窗端点
   （`OverlayController` 只画 TextView），插件无法凭空造窗。要完整桌宠，需要 DSHA 把
   悬浮层的 TextView 换成加载 `overlay.html` 的透明 WebView——插件侧页面/动画/拖拽已经是成品。
   逐移植现状见 [docs/PORT-MATRIX.md](docs/PORT-MATRIX.md)。
3. **不内置权限逻辑**。没有 `Settings.canDrawOverlays`、没有跳系统设置、没有「没权限就退回页面内显示」。
   DSHA 返回 `DISABLED` / `NO_PERMISSION` 时插件只做冷却，不重试轰炸、不代用户开开关。
4. **拖动依赖 `screenX/screenY`**。窗口模式下宿主会跟着手指移动窗口，页面必须用**屏幕坐标**算位移
   （用 `clientX/clientY` 会自锁）。个别套壳 WebView 若把 `screenX` 降级成页面坐标，表现是
   「拖不动」——此时让宿主注入 `DshOverlayHost` 桥并由宿主自己处理拖动。
5. **多宠物 = 多窗口**。每只 `display` 含 `desktop/both` 的宠物各占一个悬浮窗、一个 WebView，
   手机上开太多会明显吃内存，建议手机端只留 1 只。文本载体则只显示第一只（按 id 顺序）。
6. **不做右键菜单 / 对话 / 碎碎念开关**。这些是上游浏览器与桌面端的 UI 能力；手机上暂以
   上游设置页 + 上游 HTTP 接口（`/whisper`、`/broadcast`、`/anim`、`/chat`）为准。
   气泡与点播动画是只读消费：本页面读 `/dsh-pet-7340/state` 的 `pets.<id>.say` 与 `pets.<id>.anim`。
7. **通知、余额、工作状态联动**同样未在悬浮窗里做（上游 `sections.*` 有数据，v1 只消费 `say/anim`；
   文本载体只消费 `say`）。
8. **上游未装或未启用**时不会静默黑屏：页面显示「未找到 dsh-pet 上游插件」，
   `/status.windowReport.upstreamOk=false`；文本载体则什么都不推。
9. **素材走 blob 预取**（与上游浏览器端一致，10s 超时）：慢网络下切换动画可能跳过一两个，不影响主体。
10. **没有构建步骤**，`src/` 就是产物；改完代码重启 dsh 即可，不需要 `npm run build`。
    因此本包**不做类型检查**：用 `npm test`（三套：smoke / dsha / status-overlay）兜底。
11. 本插件**不能**被「打包进 APK / 启动器」使用：它的宿主侧依赖 dsh 的 WebServer 与 profile 机制，
    放进 APK 既违反本项目的形态约束，也无法工作。
