# 宿主契约（host contract v1）

> 本文件是**文档**，不是插件的一部分，不随插件安装、不编译进任何 APK 或启动器。
> 它写给「dsh Android 移植版 / Android 启动器」的维护者：插件已经按这份契约写好，
> 宿主按同一份契约实现，宠物就显示在系统上层。

## 责任边界（硬边界，不要挪）

| 事项 | 归属 |
| --- | --- |
| `SYSTEM_ALERT_WINDOW` 权限申请、引导、检测、失败提示 | **宿主 / 启动器** |
| `WindowManager` 窗口创建、层级、透明、触摸、销毁 | **宿主 / 启动器** |
| 前台服务的持有（Android 12+ 后台不能起前台服务） | **宿主 / 启动器** |
| 宠物配置（size / display / position / animations / physics） | 上游 `dsh-pet` |
| 渲染页面、动画、拖拽手感、气泡 | **本插件** |
| 「要不要显示」这个开关 | 本插件（写进请求文件，宿主照做） |

插件侧不含任何权限代码。权限没给，宿主就不建窗；插件只会在 `/status` 里留下「请求文件已写、宿主未应答」。

## 通道：文件

容器里的 Node 进程没有 Android `Context`，拿不到 Binder，因此通道用文件——
DSH 安卓版原本就用 `/sdcard/.dsh-phone` 做双向通信（原生灵动岛读 `hud.json`），这里是同一个模式。

目录：`/sdcard/.dsh-phone/`（插件侧可用环境变量 `DSH_PET_ANDROID_DIR` 覆盖，`/status.channel.dir` 会给实际值）。

### 插件写：`pet-overlay.json`

```json
{
  "v": 1,
  "gen": 12,
  "ts": 1760000000000,
  "enabled": true,
  "baseUrl": "http://127.0.0.1:3080/dsh-pet-android/overlay.html",
  "windows": [
    {
      "id": "auto",
      "url": "http://127.0.0.1:3080/dsh-pet-android/overlay.html?pet=auto",
      "anchor": "top-right",
      "marginX": 24,
      "marginY": 100,
      "x": 800,
      "y": 300
    }
  ]
}
```

语义：

- `gen` 单调递增。宿主只处理比上次大的 `gen`，重复读同一份是幂等的。
- `windows` 是**全量快照**：没出现在列表里的 `id` 必须关闭。
- `enabled:false` 时 `windows` 为空数组 —— 等价于「全部关闭」。插件被关闭/卸载时也会发这一份。
- `x`/`y` 可能不存在。存在时是插件侧回退通道上报的屏幕像素坐标（无 JS 桥时用）；
  不存在时宿主按 `anchor` + `marginX`/`marginY` 用自己的屏幕尺寸算。
- `url` 指向 DSH WebServer（`127.0.0.1:<port>`），宿主 WebView 直接加载即可，页面自带全部逻辑。

### 宿主写：`pet-overlay.state.json`

```json
{
  "v": 1,
  "gen": 12,
  "applied": true,
  "error": null,
  "ts": 1760000000050,
  "screen": { "w": 1080, "h": 2400, "top": 72, "bottom": 84, "density": 3 },
  "windows": [{ "id": "auto", "x": 800, "y": 300, "w": 462, "h": 701 }]
}
```

- `screen`：**物理像素**。`top`/`bottom` 是状态栏与导航栏占高，宠物不会被摆在它们下面。
  插件用它做边界反弹与角落定位；缺失时插件退化为「按窗口尺寸估计」，位置会不准。
- `applied`：这一代是否已落地（窗口都建好/关好了）。`error` 非空表示这一代失败，插件会在 `/status` 里展示原文。
- 坐标单位必须与 `screen` 一致（都是物理像素），否则拖动会漂移。

## 鉴权：DSH 的 Web 服务在 token 闸门后面

DSH 启动时打印的就绪地址带 `?token=…`（Tdsh 的 `UrlPick` 只认这种地址）。插件页面与插件路由
跑在同一个 WebServer 上，所以：

1. 宿主加载 `overlay.html` 时，把当前 token 拼上去：
   `…/overlay.html?pet=auto&token=<当前 token>`；
2. 页面会把查询串里的 `token` **转发给每一次 fetch**（配置、素材、状态、插件路由）；
3. 容器重启后 token 会变 —— 插件会用新端口发新 `gen`，宿主重取 token 再 `loadUrl` 即可。

Tdsh 的实现见 `com.dshmobile.probe.PetOverlayHost#withToken()`（宿主仓库，不在本插件内）。

## 可选加速：WebView JS 桥
宿主在建窗时可以 `addJavascriptInterface(host, "DshOverlayHost")`，页面会优先用它（同步、无轮询延迟）：

```kotlin
class DshOverlayHost(private val ctx: Context, private val winId: String) {
    @JavascriptInterface fun screenSize(): String =
        JSONObject(mapOf("w" to screenW, "h" to screenH, "top" to statusBar, "bottom" to navBar)).toString()

    @JavascriptInterface fun moveTo(x: Int, y: Int) { /* 主线程改 layoutParams.x/y + updateViewLayout */ }

    @JavascriptInterface fun resize(w: Int, h: Int) { /* 改宽高；页面首帧会按宠物配置上报一次 */ }
}
```

桥缺失时页面自动走文件通道（`POST /dsh-pet-android/pointer` → 插件写请求文件 → 宿主下一轮读）。
两条通道渲染完全一致，只有拖动跟手度不同：桥 ≈ 1 帧，文件 ≈ 轮询间隔。

## 窗口属性（参考实现）

```kotlin
val lp = WindowManager.LayoutParams(
    width, height,
    if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
    PixelFormat.TRANSLUCENT
).apply {
    gravity = Gravity.TOP or Gravity.START
    x = px; y = py
}
val web = WebView(context).apply {
    setBackgroundColor(Color.TRANSPARENT)          // 必须：否则窗口是白色板
    settings.javaScriptEnabled = true
    settings.mediaPlaybackRequiresUserGesture = false   // 宠物视频要自动播放
    settings.domStorageEnabled = true
    addJavascriptInterface(DshOverlayHost(context, winId), "DshOverlayHost")
    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest) = false
    }
    loadUrl(url)
}
wm.addView(web, lp)
```

要点（都是踩过的）：

1. 窗口必须 `PixelFormat.TRANSLUCENT` 且 WebView 背景透明，否则看不到宠物、只有一块板。
2. `mediaPlaybackRequiresUserGesture = false` 必须开，否则视频 `<video autoplay>` 永远不播。
3. 窗口尺寸以页面 `resize(w, h)` 上报为准（页面按 `size × 9/16` + 气泡留白算）。
4. 拖动由页面计算（用 PointerEvent 的 `screenX/screenY`），宿主只执行 `moveTo`；
   宿主**不要**自己再叠加触摸拖动，否则位移翻倍。
5. 多宠物 = 多个窗口（`windows[]` 里的 `auto` / `pet:<id>`），每个窗口一个 WebView，互不共享。
6. 关窗顺序：先 `wm.removeView`，再 `web.destroy()`；窗口在 `onDestroy` 之后销毁会崩。

## 附：DSHA 现状（com.dsh.client）

DSHA 已经有**一条**插件可见的系统层，但只有文本：

| 端点 | 能力 |
| --- | --- |
| `GET http://127.0.0.1:3090/app/version` | `BRIDGE_PROTOCOL=… APP_VERSION=… APP_CODE=…`，特性检测 |
| `GET /app/overlay?kind=&text=&session=` | 顶部文本悬浮条；返回 `DISABLED` / `NO_PERMISSION` / `SKIP_REASONING` / `OK` / `OK_NO_CMD` |
| `GET /app/notify|toast|vibrate` | 通知 / 提示 / 震动 |

鉴权：`X-Token: <token>`，token 由宿主写到 `/root/.dsh/.bridge_token`，
并同时提供 `curl -H @/root/.dsh/.bridge_headers` 形式。

窗口权限归 DSHA：`OverlayController.permitted()` 看 `Settings.canDrawOverlays`，
`enabled()` 看用户开关；插件只读返回值，**不申请、不引导**。

要在 DSHA 上跑出**完整桌宠窗口**，宿主只需把 `OverlayController` 的 TextView 换成
一个透明 WebView（属性见上一节），加载
`http://127.0.0.1:<web端口>/dsh-pet-android/overlay.html?pet=<id>`，
并把窗口位置/尺寸回写进 `pet-overlay.state.json`。插件侧的页面、动画、拖拽都已经是成品，
不需要改一行。

## 最小自检

宿主侧实现完，按顺序确认：

```sh
cat /sdcard/.dsh-phone/pet-overlay.json          # 插件是否在写、gen 是否在涨
cat /sdcard/.dsh-phone/pet-overlay.state.json    # 宿主是否应答、error 是否为空
curl -s http://127.0.0.1:3080/dsh-pet-android/status | head -40
```

三处都对上（`gen` 一致、`applied:true`、`/status.host.screen` 有值），宠物才会出现在应用之上。
