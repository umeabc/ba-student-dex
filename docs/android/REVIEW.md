# 什亭之匣（StudentDex）Android 移植技术设计稿（v1）架构评审意见

- **审阅对象**：[docs/android/DESIGN.md](DESIGN.md)（450 行，v1）、[docs/android/PLAN.md](PLAN.md)（292 行，v1）
- **交叉核对事实源**：[StudentDex/Sources/WebShell.swift](../../StudentDex/Sources/WebShell.swift)、[StudentDex/Sources/StudentDexApp.swift](../../StudentDex/Sources/StudentDexApp.swift)、[StudentDex/project.yml](../../StudentDex/project.yml)、[web/sync.js](../../web/sync.js)、[web/update.js](../../web/update.js)、[web/app.js](../../web/app.js)、[web/index.html](../../web/index.html)、[web/styles.css](../../web/styles.css)、[README.md](../../README.md)

---

## 1. 结论摘要

**评审结论：有条件通过（Conditional Pass）**——「`WebViewAssetLoader` + `index.html` 注入 `BridgeShim` + 单文件 `ba-sync-store.json` + 零改动 `web/`」的顶层路线成立，但设计稿存在 **5 项 P0 阻断级缺陷**（含 2 处直接编译失败、2 处高优 UI 事故、1 处 WebView 资源响应契约错误），必须按本文修定后方可进入 M0/M1 编码：

1. **【编译阻断】** `MainActivity` 继承 `android.app.Activity` 却调用 `ComponentActivity` 专属的 `enableEdgeToEdge()` 与 `onBackPressedDispatcher`（`DESIGN.md:29, 48, 276, 313`）。
2. **【编译阻断】** AGP 8.7.3 默认关闭 `BuildConfig` 生成，`MainActivity` 直接引用 `BuildConfig.DEBUG` 会报 `Unresolved reference`（`DESIGN.md:219, 368-381`）。
3. **【UI 阻断】** `WindowInsetsCompat` 返回的 `sys.top`/`sys.bottom` 是**物理像素**，未除以 `density` 就直接作为 CSS `px` 写入 `--safe-t`/`--safe-b`，在 320dpi（2x）/ 480dpi（3x）设备上会导致顶底安全区放大 2–3 倍（`DESIGN.md:314-316`）。
4. **【UI 阻断】** 搜索框 `#q` 位于页面最顶部 `.topbar`（`web/app.js:811`），对 `WebView` 设置 `translationY = -ime.height.toFloat()` 会把顶部搜索框整体推出屏幕上方不可见（`DESIGN.md:317`）。
5. **【功能阻断】** `PLAN.md:191` 要求返回 `mimeType` 为 `"text/html; charset=utf-8"` 的 `WebResourceResponse`，违反 Android API「`mimeType` 不得含 `; charset` 参数」契约，且未限定每次拦截新建 `ByteArrayInputStream` 及禁止无尾斜杠 `/assets` 命中（`DESIGN.md:115`、`PLAN.md:191`）。

---

## 2. 阻断级问题（P0，必须改完才能开工）

### P0-1：`android.app.Activity` 无法使用 `enableEdgeToEdge()` 与 `onBackPressedDispatcher`
- **【位置】** `DESIGN.md:29, 48, 276, 307, 313, 356`
- **【问题】** 类图与正文将 `MainActivity` 声明为 `android.app.Activity`，同时调用 `enableEdgeToEdge()` 与 `onBackPressedDispatcher.addCallback(this) { ... }`。
- **【证据/依据】** `enableEdgeToEdge()` 是 `androidx.activity.ComponentActivity` 的扩展函数（`androidx.activity.EdgeToEdge`）；`onBackPressedDispatcher`（`OnBackPressedDispatcherOwner`）与 `addCallback(LifecycleOwner)` 所需的 `LifecycleOwner` 也均由 `ComponentActivity` 实现，平台 `android.app.Activity` 无上述 API，编译必败。
- **【建议改法】**
  1. `MainActivity` 改为继承 `androidx.activity.ComponentActivity`（已在依赖 `androidx.activity:activity-ktx:1.9.3` 中，**无需**引入 `androidx.appcompat`）。
  2. `ComponentActivity` 不强制 AppCompat 主题，可继续使用平台 Material 主题，但 XML `parent` 必须带 `android:` 命名空间前缀：`res/values/themes.xml` 用 `parent="android:Theme.Material.Light.NoActionBar"`，`res/values-night/themes.xml` 必须改为深色 parent `parent="android:Theme.Material.NoActionBar"`（勿在 night 下继承 `.Light`）。

### P0-2：安全区注入混淆物理像素（px）与 CSS 逻辑像素（dp），导致安全区膨胀 2–3 倍
- **【位置】** `DESIGN.md:314-316`
- **【问题】** `applyCssVars` 直接执行 `setProperty('--safe-t','${sys.top}px')` 与 `'--safe-b','${sys.bottom}px'`。
- **【证据/依据】** iOS `WebShell.swift:10-14` 的 `safeAreaInsets.top/bottom` 单位是 UIKit point（`1pt == 1 CSS px`）；而 Android `WindowInsetsCompat.getInsets(...).top/bottom` 返回的是**物理像素（physical px）**。`web/index.html:5` 设置了 `width=device-width, initial-scale=1`，WebView 内 `1 CSS px == 1 dp`。在验证机（900×1600 @320dpi，`density=2.0`）上，24dp 状态栏的 `sys.top = 48`，直传 `48px` 会使 `.topbar`（`web/styles.css:75`）顶部内边距变成 96 物理像素（2 倍高）；在 480dpi 真机上会膨胀至 3 倍。
- **【建议改法】** 注入前必须除以 `resources.displayMetrics.density` 转为 CSS 逻辑像素：
  `val d = resources.displayMetrics.density; val topDp = (sys.top / d).roundToInt(); val bottomDp = (sys.bottom / d).roundToInt()`，再拼入 `'${topDp}px'` / `'${bottomDp}px'`。

### P0-3：IME 处理 `webView.translationY = -ime.height` 会将顶部搜索框推出屏幕外
- **【位置】** `DESIGN.md:317, 395`
- **【问题】** 监听 `WindowInsetsCompat.Type.ime()` 并在键盘弹出时设置 `webView.translationY = -ime.height.toFloat()`。
- **【证据/依据】** 核查 `web/` 全站源码，唯一输入框是列表页顶部的 `<input id="q" type="search">`（`web/app.js:811`），位于 `position: sticky; top: 0` 的 `.topbar` 内（`web/styles.css:71-75`）。键盘高度约 260–320dp（模拟器上 520–640px），将 `webView` 整体上移 `-ime.height` 会把页面顶部的 `.topbar`、搜索框 `#q` 及首屏搜索结果全部推出屏幕上边界之外，导致用户盲打；且与 `AndroidManifest.xml` 的 `windowSoftInputMode="adjustResize"`（`DESIGN.md:395`）冲突。iOS `WebShell.swift:10-14, 139` 同样不对键盘做任何 WebView 位移。
- **【建议改法】** **彻底删除 `webView.translationY = -ime.height.toFloat()` 及 `Type.ime()` 位移逻辑**；因唯一输入框恒在顶部，软键盘从底部升起绝不会遮挡搜索框。Manifest 中 `windowSoftInputMode` 改为 `adjustPan` 或 `adjustNothing`。

### P0-4：`WebResourceResponse` 的 `mimeType` 格式冲突与 `InputStream` 复用/路径解析隐患
- **【位置】** `DESIGN.md:115` vs `PLAN.md:191`
- **【问题】** `PLAN.md:191` 要求返回「带 `text/html; charset=utf-8` 的 `WebResourceResponse`」；`DESIGN.md:115` 允许拦截无尾斜杠的 `/assets` 根请求直接返回 HTML。
- **【证据/依据】**
  1. `WebResourceResponse(String mimeType, String encoding, InputStream data)` 官方文档明文规定：`mimeType` **严禁包含 `; charset=utf-8` 等参数**，否则 Chromium `AwContentsIoThreadClient` 解析 MIME 失败，会导致页面无法按 HTML 渲染。
  2. 若对无尾斜杠的 `https://appassets.androidplatform.net/assets` 直接返回 HTML，浏览器会将相对路径 `<script src="data.js">`（`web/index.html:30`）解析为 `https://appassets.androidplatform.net/data.js`（丢失 `/assets/` 前缀），导致 `WebViewAssetLoader` 全部 404。
  3. `injectedIndexHtml` 缓存的必须是 `ByteArray`，每次 `shouldInterceptRequest` 命中时必须**新建** `ByteArrayInputStream(injectedIndexHtml)`（复用同一 `InputStream` 会因流游标到末尾导致后续加载白屏）。
- **【建议改法】** 严格使用 `WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(cachedBytes))`；仅当 `request.url.host == "appassets.androidplatform.net" && (request.url.path == "/assets/index.html" || request.url.path == "/assets/")` 时返回注入后的 HTML，其余全部委托 `loader.shouldInterceptRequest(request.url)`。

### P0-5：AGP 8.7.3 默认不生成 `BuildConfig`，引用 `BuildConfig.DEBUG` 编译报错
- **【位置】** `DESIGN.md:219, 368-381`
- **【问题】** `MainActivity` 使用 `if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)`，但 `build.gradle.kts` 未启用 `buildConfig`。
- **【证据/依据】** AGP 8.0+ 默认 `android.defaults.buildfeatures.buildconfig=false`，`DESIGN.md:368-381` 的 `build.gradle.kts` 未配置 `buildFeatures { buildConfig = true }`，编译会直接报 `Unresolved reference: BuildConfig`。
- **【建议改法】** 改用无需生成类的运行时判断：`if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true)`（或在 `build.gradle.kts` 中显式声明 `buildFeatures { buildConfig = true }`）。

---

## 3. 重要问题（P1，开工前应定稿）

### P1-1：深色模式不重载方案存在主题锁死与闪白缺陷
- **【位置】** `DESIGN.md:239, 307-310, 414`
- **【问题】** `values/themes.xml` 锁死 `.Light`、未设 `webView` 透明底色，且未准备 `prefers-color-scheme` 不随 `configChanges` 重算时的兜底。
- **【证据/依据】**
  1. `values/themes.xml` 继承 `Theme.Material.Light.NoActionBar`（`android:isLightTheme="true"`），而 `DESIGN.md:308` 在 `values-night` 中仅改了 `windowBackground` 未改 parent 为深色主题；且 `uiMode` 进 `configChanges` 后 Activity 不重建，Theme 的 `isLightTheme` 不会随系统切换自动更新，在部分 WebView 版本下会导致 `@media (prefers-color-scheme: dark)` 无法响应式切换（**需实测** WebView 146 行为）。
  2. 未设置 `webView.setBackgroundColor(Color.TRANSPARENT)`，`WebView` 默认不透明纯白底色会在深色冷启动首帧前闪白。
  3. `web/index.html` 无 `<meta name="color-scheme">`，**切勿**开启 `WebSettingsCompat.setAlgorithmicDarkeningAllowed(true)`，否则 WebView 会对已适配深色变量的页面做算法二次反色。
- **【建议改法】**
  1. `values-night/themes.xml` parent 设为 `android:Theme.Material.NoActionBar`。
  2. 初始化时设 `webView.setBackgroundColor(Color.TRANSPARENT)` 与 `webView.isVerticalScrollBarEnabled = false`（对齐 `WebShell.swift:136-140`）。
  3. `onConfigurationChanged` 首行必须调 `super.onConfigurationChanged(newConfig)`。
  4. **兜底方案**：若实测 `cmd uimode night yes/no` 后 `matchMedia('(prefers-color-scheme: dark)').matches` 未同步，在 `onConfigurationChanged` 中通过 `evaluateJavascript` 注入/移除覆盖 `:root` 的 15 个深色 CSS 变量（`web/styles.css:28-43`），实现 0ms、0 重载确定性切换。

### P1-2：返回栈悬空 entry 在 Android 上可累积 N 层，「与 iOS 一致」断言不成立
- **【位置】** `DESIGN.md:84, 276-282`、`PLAN.md:125, 233`
- **【问题】** 将悬空 history entry 标为「与 iOS 一致，不修」，导致 Android 用户浏览 N 个学生后需连按 N+1 次返回键才能退出。
- **【证据/依据】** iOS 无系统返回键且 `allowsBackForwardNavigationGestures = false`（`WebShell.swift:141`），从不触发 `goBack()/popstate`。但在 Android 上，每次 `openDetail`（`web/app.js:855` `pushState`）后，点页面左上角返回（`app.js:955`）或用 JS 左缘右滑返回（`app.js:938`）都只调 `closeDetail()` 不回退 history；详情页点「同名角色」（`app.js:737`）还会叠加 `pushState`。用户浏览 N 个学生回到列表后，按系统返回键会连续触发 N 次空 `popstate`；且打开筛选面板（`#sheet`）或更新弹窗（`#update-modal`）时按返回键无法关闭浮层。
- **【建议改法】** 在 **零改动 `web/`** 前提下，将 `onBackPressedDispatcher` 回调改为通过 `webView.evaluateJavascript` 检查页面状态：若存在 `#update-modal`、`#sheet:not([hidden])` 或 `#detail.in`，则在 JS 中触发对应关闭按钮并在详情关闭后清退 history；若当前已在主列表且无浮层，**直接调用 `finish()`**，彻底消除 N 次空按问题。

### P1-3：左缘手势排除违反 Android 200dp 配额上限与布局时机
- **【位置】** `DESIGN.md:292-299`、`PLAN.md:124, 233`
- **【问题】** 一次性传入 `32dp × webView.height` 全高矩形。
- **【证据/依据】** `View.setSystemGestureExclusionRects` 官方规定每侧边缘最多排除 **200dp**；传入全高（模拟器 1600px = 800dp）矩形时，系统仅截取底部 200dp 生效，上部 600dp 仍为系统返回手势。且若不在 `OnLayoutChangeListener` 中更新，初始 `webView.height == 0` 时完全无效。实际上系统返回手势触发 `OnBackPressedDispatcher` 同样能关闭详情，UX 结果等价。
- **【建议改法】** 在 `webView.addOnLayoutChangeListener` 中仅对左缘下中部设置 `200dp × 32dp` 矩形；M3 验收标准改为分别验证底部 200dp 内 JS 跟手右滑返回与上部系统返回手势关闭详情。

### P1-4：`store.save` 双重 `JSON.stringify` 与 `JavaBridge` 同步线程解析阻塞
- **【位置】** `DESIGN.md:126, 140-142, 175`、`PLAN.md:231`
- **【问题】** `BridgeShim` 对已序列化的 `msg.value` 二次 `JSON.stringify`，且 `BaBridge.rpc` 在 `JavaBridge` 线程同步解析大 JSON。
- **【证据/依据】** `sync.js:244-248` 明文不下载立绘（纠正 `DESIGN.md:175`「同步立绘数百 KB」的误述），但每名同步学生含数十个缩略图标 data URI（约 150–300KB/人），多次同步后 `ov` 可达数 MB。`sync.js:91` 已 `JSON.stringify(ov)`，`BridgeShim`（`DESIGN.md:126`）再 `JSON.stringify(msg)` 会对数 MB 字符串做二次转义，而 `BaBridge.rpc`（`DESIGN.md:141`）在同步阻塞 V8 主线程的 `JavaBridge` 线程先调 `JSONObject(json)` 再切 `io` 线程，存在主线程卡顿与多倍内存峰值风险。
- **【建议改法】**
  1. `BaBridge.rpc(json)` 首行立即 `io.execute { ... }` 异步化，不在 `JavaBridge` 线程解析 JSON。
  2. 在 `BridgeShim` 中对 `msg.op === 'store'` 直接转发至 `@JavascriptInterface fun store(id: String, action: String?, value: String?)`，省去对 `value` 的二次序列化与反序列化。

### P1-5：`HttpURLConnection` 非 2xx 抛异常、`File.renameTo` 静默失败与白名单遗漏
- **【位置】** `DESIGN.md:155, 185, 229`
- **【问题】** `HttpURLConnection` 错误流与 `File.renameTo` 返回值处理不当导致状态码与 iOS 分叉；正文漏贴 4 个白名单域名。
- **【证据/依据】**
  1. HTTP 状态码 ≥ 400 时调 `conn.inputStream` 会抛 `IOException`，若被笼统 catch 置 `status=0`，会吞掉真实的 `403/404/500` 状态码（违背 `WebShell.swift:80` 与 `sync.js:66`）。
  2. `File.renameTo` 失败返回 `false` 而不抛异常，`try/catch` 无法捕获写失败回 `500`。
  3. `WebShell.swift:88` 在 `op=="store"` 时 `action` 缺省为 `"load"`，`DESIGN.md:142` 漏写；`DESIGN.md:185` 写「上述 4 域」，但 `DESIGN.md` 正文从未列出这 4 个域名。
- **【建议改法】**
  1. 先取 `val status = conn.responseCode`，再按 `status in 200..399` 读 `inputStream` 或 `errorStream`，`finally` 中 `conn.disconnect()`。
  2. 改用 `androidx.core.util.AtomicFile(storeFile)` 或校验 `if (!tmp.renameTo(storeFile)) throw IOException()`。
  3. 在 `DESIGN.md` §4.3 补齐 4 个白名单域名与 `action` 缺省 `"load"`。

### P1-6：WebView 安全开关、崩溃重建父容器移除与外链防护缺口
- **【位置】** `DESIGN.md:77, 231, 259, 309, 391`
- **【问题】** 误判 `allowFileAccess` 默认值、`allowBackup` 前后矛盾、`onRenderProcessGone` 未从父容器移除死 WebView、使用废弃状态栏 API。
- **【证据/依据】**
  1. `allowFileAccess` 在 API 24–29 默认为 `true`，`allowContentAccess` 在所有版本（含 API 35）默认为 `true`，并非 `DESIGN.md:77` 所称「默认关闭」。
  2. `DESIGN.md:231`（不声明 `allowBackup`）与 `DESIGN.md:391`（`allowBackup="false"`）前后矛盾。
  3. `onRenderProcessGone`（`DESIGN.md:259`）调 `webView.removeAllViews()` 无法将 `webView` 从 Activity 视图树移除。
  4. `window.statusBarColor/navigationBarColor`（`DESIGN.md:309`）在 API 35 已废弃；`web/app.js:745, 1214` 的外链均带 `target="_blank" rel="noreferrer/noopener"`。
- **【建议改法】**
  1. 显式设 `settings.allowFileAccess = false; settings.allowContentAccess = false`，并在 `shouldInterceptRequest` 中拒绝非 `appassets.androidplatform.net` 请求。
  2. 统一 `android:allowBackup="false"`；`onRenderProcessGone` 改为 `(webView.parent as? ViewGroup)?.removeView(webView)` 后再 `webView.destroy()`。
  3. 用 `enableEdgeToEdge(statusBarStyle, navigationBarStyle)` + `window.isNavigationBarContrastEnforced = false`；`shouldOverrideUrlLoading` 中对非本 origin 的 `http(s)` 用 `try { startActivity(Intent(ACTION_VIEW, uri)) } catch (_: ActivityNotFoundException) {}` 并返回 `true`。

---

## 4. 建议（P2，可选优化）

1. **开启 `noCompress` 加速 8.8MB `data.js` 加载（`PLAN.md:227`）**：在 `android/app/build.gradle.kts` 中配置 `androidResources { noCompress += listOf("js", "css", "html", "json") }`，使 `AssetManager.open("data.js")` 免解压流式直读，APK 仅增约 6MB（仍低于 60MB 预算），可明显缩短首屏耗时。
2. **排除 `web/` 下的测试页并修正设备 dp 换算**：实测 `web/` 含 `web/_test.html` 与 `web/_test-update.html`（共 3889 文件，iOS `StudentDex/Resources/Web` 实际为 3887 文件），可在 `assets.exclude("_test*.html")` 过滤；另验证机 `900x1600 @320dpi`（`density=2.0`）实际为 `450×800dp`（非 360×640dp）。
3. **入口 HTML 读取失败兜底**：对齐 `WebShell.swift:146-148`，若 `assets.open("index.html")` 抛异常，返回内联错误提示 HTML 避免空白页。

---

## 5. 逐条核实表（A–J）

| 编号 | 核实项 | 结论 | 一句话理由与依据 |
| :---: | --- | :---: | --- |
| **A** | `android.app.Activity` + `enableEdgeToEdge` / `onBackPressedDispatcher` | **不成立** | 两者均为 `androidx.activity.ComponentActivity` 专属 API，`android.app.Activity` 无法编译；最小改法是继承 `ComponentActivity`（无需 AppCompat 主题，XML parent 加 `android:` 前缀）。 |
| **B** | `translationY = -ime.height` 模拟 `adjustResize` | **不成立** | 唯一输入框 `#q` 在页面最顶部 `.topbar`（`app.js:811`），上移 `WebView` 会把搜索框推出屏幕外；应删除位移逻辑，不做 IME 平移。 |
| **C** | 左缘 `32dp × 全高` `setSystemGestureExclusionRects` | **不成立** | Android 10+ 限制单边排除上限为 200dp，800dp 全高矩形仅底部 200dp 生效；应放入 `OnLayoutChangeListener` 限高 200dp，且系统返回手势本身亦能通过 `OnBackPressedDispatcher` 关详情。 |
| **D** | `uiMode` 进 `configChanges` 时 `prefers-color-scheme` 自动重算 | **存疑** | `values/themes.xml` 锁死 `.Light` 且不重建 Activity 可能导致 WebView 146 的深浅色媒体查询不翻转（**需实测**）；需修 `values-night` parent 并准备动态注入深色 CSS 变量的兜底。 |
| **E** | `WebViewAssetLoader` + 拦截 `index.html` 注入 shim | **存疑** | 架构成立且 `<head>` 内联脚本必早于 `body` 尾的 `data.js`/`sync.js`，但 `PLAN.md:191` 将 `mimeType` 写成 `"text/html; charset=utf-8"` 违反 API 契约，且需每次新建 `ByteArrayInputStream`、禁拦无尾斜杠 `/assets`。 |
| **F** | `addJavascriptInterface` 传数 MB `store.save` 不分块 | **存疑** | 通道上限够用（且 `sync.js:247` 不下立绘），但 `BridgeShim` 二次 `JSON.stringify` + `JavaBridge` 线程同步 `JSONObject(json)` 会阻塞 V8 主线程；应首行切 `io` 线程并为 `store` 提供直传方法。 |
| **G** | 返回栈悬空 entry 标为「与 iOS 一致、不修」 | **不成立** | iOS 无返回键且禁了边缘导航手势，从不触发 `popstate`；Android 上浏览 N 个学生后需连按 N+1 次返回键才能退出，应通过 `evaluateJavascript` 在主列表且无浮层时直接 `finish()`。 |
| **H** | `addJavascriptInterface` 安全性与 `allowBackup=false` | **存疑** | 本地 origin 风险可控，但 `DESIGN.md:77` 误判 `allowFileAccess/allowContentAccess` 默认关闭，且 `DESIGN.md:231` 与 `:391` 对 `allowBackup` 自相矛盾；统一 `allowBackup=false` 不影响本机 localStorage 持久。 |
| **I** | 完整性与里程碑/README 对照遗漏 | **存疑** | 涵盖主体功能，但漏了 AGP 8.7.3 `BuildConfig` 默认关闭、`HttpURLConnection` ≥400 读 `errorStream`、`onRenderProcessGone` 从 parent 移除 `webView`、`webView` 透明底色与废弃状态栏 API。 |
| **J** | 数字与仓库/iOS 事实一致性 | **存疑** | 281 名学生、1.0.1、WebView 146、55–56MB 核对一致；但 3889 文件含 2 个 `_test*.html`（iOS 实际 3887），`DESIGN.md` 漏写 4 个白名单域名，且誤称同步会下载立绘大图。 |

---

## 6. 设计稿中「与 iOS 对齐」断言的抽查结果

| 设计稿断言 | 核查结果 | 事实对照（`WebShell.swift` / `web/`） |
| --- | :---: | --- |
| 桥协议、UA 串、4 域名白名单、仅 https、非法回 `status=0` | **真对齐** | 与 `WebShell.swift:33-68, 105-111` 逐字符一致（但 `DESIGN.md` 正文漏贴 4 个域名，需从 `PLAN.md:17` 补入）。 |
| `store` 忽略 `key`、单文件 `ba-sync-store.json`、缺文件回 `200+""` | **真对齐** | 与 `WebShell.swift:44-47, 87-101` 完全一致；唯漏写 `action` 缺省值为 `"load"`（`WebShell.swift:88`）。 |
| `onPageFinished` 重放 `--safe-t/--safe-b` | **真对齐** | 与 `WebShell.swift:191-196` `didFinish` 重放一致。 |
| `--safe-t/--safe-b` 传 `${sys.top}px` 与 iOS 逐字同构（`DESIGN.md:316`） | **过度声称（错）** | iOS `safeAreaInsets` 是逻辑 `pt`，Android `WindowInsetsCompat` 是**物理 `px`**，不除以 `density` 会差 2–3 倍。 |
| 返回栈悬空 entry「与 iOS 一致，不修」（`DESIGN.md:282`） | **过度声称（错）** | iOS 无返回键且 `allowsBackForwardNavigationGestures = false`（`:141`），从不触发 `goBack()`，该缺陷仅在 Android 暴露且随浏览次数 N 次累加。 |
| 同步立绘（数百 KB）经同一通道（`DESIGN.md:175`、`PLAN.md:231`） | **事实失实** | `web/sync.js:244-248` 明文清空 `s.portraits = []; s.hall = { image: '' }`，同步根本不下载立绘。 |
| WebView 背景与滚动条对齐（`DESIGN.md:308`） | **有遗漏** | `WebShell.swift:136-140` 设了 `isOpaque = false` 与 `showsVerticalScrollIndicator = false`，Android 设计漏设 `webView.setBackgroundColor(Color.TRANSPARENT)` 与隐藏垂直滚动条。 |

---

## 7. 给实现者（Codex）的额外红旗清单（8 条）

1. **【红旗 1 · `ComponentActivity` 与主题前缀】** `MainActivity` 必须继承 `androidx.activity.ComponentActivity`；`res/values/themes.xml` 的 parent 必须写 `android:Theme.Material.Light.NoActionBar`，`res/values-night/themes.xml` 必须写 `android:Theme.Material.NoActionBar`（带 `android:` 前缀且 night 去掉 `.Light`）。
2. **【红旗 2 · Insets 必须除以 `density` 且删掉 IME `translationY`】** 注入 `--safe-t`/`--safe-b` 前必须用 `(sys.top / resources.displayMetrics.density).roundToInt()` 换算为 dp；**严禁**写 `webView.translationY = -ime.height.toFloat()`。
3. **【红旗 3 · `WebResourceResponse` 严禁带 `; charset`】** 拦截 `index.html` 时必须写 `WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(cachedBytes))`，第一个参数只能是 `"text/html"`；每次调用必须 `new ByteArrayInputStream`，且不要拦截无尾斜杠的 `/assets`。
4. **【红旗 4 · `HttpURLConnection` 的 4xx/5xx 与 `AtomicFile`】** 先读 `val code = conn.responseCode`，再 `val stream = if (code in 200..399) conn.inputStream else conn.errorStream`（否则 403/404 会抛异常变 `status=0`）；写 `ba-sync-store.json` 用 `androidx.core.util.AtomicFile` 或显式校验 `if (!tmp.renameTo(dst)) throw IOException()`。
5. **【红旗 5 · `BaBridge` 切线程与 `store` 直传】** `@JavascriptInterface` 方法会同步阻塞 JS 渲染线程：`rpc(json)` 第一行必须直接 `io.execute { ... }`，绝不在 `JavaBridge` 线程调 `JSONObject(json)`；在 `BridgeShim` 中把 `op === 'store'` 直接路由到 `@JavascriptInterface fun store(id: String, action: String?, value: String?)` 避免数 MB 字符串二次转义。
6. **【红旗 6 · 返回键防 N 次空按】** 不要无脑写 `if (webView.canGoBack()) webView.goBack() else finish()`；在 `onBackPressedDispatcher` 中用 `evaluateJavascript` 判断：若 `#update-modal`、`#sheet:not([hidden])` 或 `#detail.in` 打开则关对应层，若已在主列表页则**直接 `finish()`**。
7. **【红旗 7 · `BuildConfig.DEBUG` 与 `onRenderProcessGone` 正确写法】** 用 `(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0` 替代 `BuildConfig.DEBUG`；`onRenderProcessGone` 中移除死 WebView 必须写 `(view.parent as? ViewGroup)?.removeView(view)` 后再 `view.destroy()`，不能只写 `view.removeAllViews()`。
8. **【红旗 8 · WebView 底色、安全开关与 `shouldInterceptRequest` 线程】** 初始化 WebView 必加 `webView.setBackgroundColor(Color.TRANSPARENT)`、`settings.allowFileAccess = false`、`settings.allowContentAccess = false`；`shouldInterceptRequest` 跑在后台线程，内部**严禁**调用任何 `webView.*` 方法。
