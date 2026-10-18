# 移植适用矩阵（port matrix）

本插件不绑定某一个安卓壳子：**载体是探测出来的，不是写死的**。这一页说明每个移植上"能玩到什么程度"，
以及差的那一步在宿主侧还是插件侧。

## 两条载体（插件会自动选）

| 载体 | 谁提供窗口 | 能给什么 | 插件侧文件 |
| --- | --- | --- | --- |
| `host-window` | 宿主实现契约 v1（见 [HOST-CONTRACT.md](HOST-CONTRACT.md)）：读 `pet-overlay.json`、建透明悬浮窗、回 `pet-overlay.state.json` | **完整桌宠**：动画、拖拽抛掷、气泡、多宠物 | `src/carrier.js` + `src/overlay/*` |
| `statusOverlay` | 宿主自带的文本悬浮层（DSHA 的 `/app/overlay`） | **在场文本**：顶部一行「名字：说的话」，系统级悬浮、叠在别的应用上 | `src/adapters/dsha.js` |

选择规则：`auto`（默认）= 窗口载体落地（宿主回了 `applied:true` 且有窗口）就不用文本；
否则用文本悬浮条。可在控制面板里改 `auto / on / off`。

## 各移植现状

| 移植 | 包名 / 仓库 | 宿主通道（有据可查） | 本插件表现 | 差在哪 |
| --- | --- | --- | --- | --- |
| **DSHA** | `com.dsh.client` · [DSH-APP/DSHA](https://github.com/DSH-APP/DSHA) | 3090 桥 + `X-Token`（token 在 `/root/.dsh/.bridge_token`，头文件 `.bridge_headers`）；`/app/overlay` 文本悬浮条（`TYPE_APPLICATION_OVERLAY`，**权限由 DSHA 申请**）；`/app/version` 做特性探测 | **开箱可用**：探测 3090 → 宠物的话实时上系统悬浮条；`/app/notify|vibrate|toast` 可选 | 完整宠物窗口需要 DSHA 实现契约 v1。它的 3090 桥**没有** WebView / 图片悬浮窗端点（OverlayController 只画 TextView），插件无法凭空造窗 |
| **Tdsh** | `com.dshmobile.probe` · [Tongyu3/Tdsh](https://github.com/Tongyu3/Tdsh-DSH-Mobile-Android-NO-ROOT) | **宿主侧已实现**：`PetOverlayHost` 挂在 `DshService`，读请求文件 → 建透明悬浮窗 → 回写状态；`DshOverlayHost` 桥提供 `moveTo/resize/screenSize` | **完整桌宠**：动画、拖拽抛掷、气泡、多宠物 | 无（已打通）。注意 DSH 的 Web 在 token 闸门后，宿主会把 token 透传给页面 |
| **dsh-fusion** | `io.dsh.fusion` · [yuchen1017918/dsh-fusion](https://github.com/yuchen1017918/dsh-fusion) | 自带 `android_*` 设备工具；桌面宠物实现未在 README 说明 | 自动探测：有文件通道/窗口契约就出完整宠物，否则退回文本/页面预览 | 未核实其悬浮接口；按契约 v1 接即可 |
| **dsh-android** | [yhm080315-sudo/dsh-android](https://github.com/yhm080315-sudo/dsh-android) | 自带 bionic Node，无公开悬浮接口 | 同上（自动探测） | 同左 |
| **dsh-fcl-launcher** | [sqkl520/dsh-fcl-android-launcher](https://github.com/sqkl520/dsh-fcl-android-launcher) | proot + FCL 风格 GUI | 同上 | 同左 |
| **桌面端 dsh** | `dsh` / `dsh web` | 无 Android 窗口；Electron 分支由上游 dsh-pet 负责 | 本插件只提供 `overlay.html?preview=1` 预览与契约自检 | 不属于本插件目标场景 |

> DSHA 的 `dsh-status-overlay` 内置插件就是"文本上屏"的官方做法（`/app/overlay`），本插件的
> `statusOverlay` 载体与它同一套端点、同一个 token 来源，互不冲突：它显示 agent 输出，本插件显示宠物的话。

## 判断你这台机器走哪条路

```sh
curl -s http://127.0.0.1:<web端口>/dsh-pet-android/status
```

看 `carriers`：

- `carriers.window.applied: true` → 完整桌宠已落地；
- `carriers.statusOverlay.detected: true` → DSHA 文本载体可用（`usable` 反映开关/权限/冷却）；
- 两个都 false → 宿主既不读文件也没有 3090 桥：插件仍正常加载，只是"看不见宠物"，页面预览可用于自查。

## 给宿主维护者的一句话

契约 v1 只要求宿主做三件事：**读一个 JSON、建一个透明 WebView 窗、回写一个 JSON**。
DSHA 侧的文本悬浮条已经证明了"宿主愿意给插件一个系统层"这条路是通的；把
`OverlayController` 从 TextView 换成一个加载 `overlay.html` 的透明 WebView，就是在 DSHA 上
跑出完整桌宠的最短路径（参考实现见 [HOST-CONTRACT.md](HOST-CONTRACT.md#窗口属性参考实现)）。
