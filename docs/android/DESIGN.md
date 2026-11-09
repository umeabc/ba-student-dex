# 什亭之匣（StudentDex）Android 移植 · 技术设计稿 v1

状态：供审阅（v1）
配套文档：[docs/android/PLAN.md](PLAN.md)（里程碑、任务拆解、风险与验收）
事实来源：`StudentDex/Sources/WebShell.swift`、`StudentDex/Sources/StudentDexApp.swift`、`StudentDex/project.yml`、`web/sync.js`、`web/update.js`、`web/app.js`、`web/index.html`、`web/styles.css`。本文所有"iOS 侧行为"均出自这些文件，无臆测。

---

## 1. 概述与约束

App = 离线 Web SPA（`web/`，约 56MB、3889 个文件）+ 薄原生外壳。Android 端交付一个 Kotlin 单 Activity 工程（`android/`），职责限定为五件事：

1. 用一个**可持久化的安全 origin** 加载页面（localStorage 存收藏）；
2. 提供**行为与 iOS `BridgeHandler` 逐项对齐**的原生桥（WIKI 同步 + GitHub 更新检查）；
3. 把 WindowInsets 反射成 `--safe-t/--safe-b`；
4. 返回键/手势与 SPA 的 history 栈正确互动，外链转交系统浏览器；
5. 深色模式跟随系统，外壳（窗口背景/状态栏）同步。

硬约束：

- `web/`、`StudentDex/` 零改动；资源零拷贝（`assets.srcDir("../../web")`）。
- 构建环境固定：SDK `D:/harness/.build-env/android-sdk`（android-35 / build-tools 34.0.0、35.0.0）、Gradle 8.14.5（`D:/harness/.build-env/gradle-8.14.5/bin/gradle`）、AGP 8.7.3 + Kotlin 2.0.21（本地缓存）、JDK 21。
- 验证环境：LDPlayer14（Android 14 / API 34），系统 WebView 146，`emulator-5554`。
- 版本与身份与 iOS 对齐：versionName `1.0.1`（`project.yml` MARKETING_VERSION），applicationId `com.sensei.studentdex`（`PRODUCT_BUNDLE_IDENTIFIER`），应用名「什亭之匣」（`CFBundleDisplayName`）。

## 2. 模块与类图（文字版）

```
MainActivity (android.app.Activity, 竖屏锁定)
 ├─ webView: WebView                      // 唯一 View，match_parent，edge-to-edge 全屏
 ├─ assetServer: AssetServer
 │    ├─ loader: WebViewAssetLoader       // /assets/ → AssetsPathHandler(context)
 │    └─ injectedIndexHtml: ByteArray     // index.html + <head> 后插入 BridgeShim.SCRIPT（缓存）
 ├─ dexWebViewClient: DexWebViewClient (WebViewClient)
 │    ├─ shouldInterceptRequest → assetServer.intercept(request)
 │    ├─ shouldOverrideUrlLoading → 外链 ACTION_VIEW / 其余放行
 │    └─ onPageFinished → insetsController.replayInsets()
 ├─ baBridge: BaBridge                    // addJavascriptInterface(baBridge, "__baNative")
 │    ├─ @JavascriptInterface rpc(json)   // JavaBridge 线程进入
 │    ├─ io: ExecutorService              // 网络与文件 I/O
 │    ├─ allowedHosts / UA / TIMEOUT_25S  // 与 WebShell.swift 常量逐字对齐
 │    └─ storeFile: File = filesDir/ba-sync-store.json
 ├─ insetsController: InsetsController
 │    ├─ setOnApplyWindowInsetsListener   // systemBars|displayCutout|ime
 │    ├─ applyCssVars(top,bottom)         // evaluateJavaScript 设置 --safe-t/--safe-b
 │    ├─ syncChrome(night)                // 状态栏图标明暗 + window 背景
 │    └─ gestureExclusion                 // 左缘 ~32dp 矩形 setSystemGestureExclusionRects
 └─ onBackPressedDispatcher.addCallback   // canGoBack()→goBack() else finish()

BridgeShim (object)
 ├─ SCRIPT: String          // 伪造 window.webkit.messageHandlers.ba 的 JS（§4.2）
 └─ jsStringLiteral(s): String // 原生→JS 回调的参数转义（§4.5）
```

依赖关系：MainActivity 组装一切；DexWebViewClient 依赖 AssetServer 与 InsetsController；BaBridge 只被 MainActivity 持有并通过 `addJavascriptInterface` 暴露，回调时需要 webView 引用（弱引用，防泄漏）。无其他依赖，不引入 Fragment/Compose/OkHttp/RxJava。

## 3. 页面加载方案（选型论证）

### 3.1 候选

| 方案 | origin | localStorage | 相对路径 fetch/img | CORS/CSP | 结论 |
| --- | --- | --- | --- | --- | --- |
| A. `file:///android_asset/index.html` | `file://` | Android WebView 对 file:// 的 localStorage **不持久**（每次安装/某些版本重启即丢，且行为随 WebView 版本漂移） | 可用 | file:// 下 fetch 受限 | ❌ 违反硬约束（收藏是核心功能，`app.js:20-33` 的降级就是为 file:// 准备的内存壳） |
| B. 手写 `shouldInterceptRequest` + 本地 HTTP server（`127.0.0.1:port`） | `http://127.0.0.1:port` | ✅ 持久 | ✅ | 需自管 server 生命周期、端口占用、Range 请求、mime 表；`android:usesCleartextTraffic` 需放开 | ❌ 代码量与风险不成比例，全部为了重造 WebViewAssetLoader |
| C. 手写 `shouldInterceptRequest` 直接拼 `WebResourceResponse`（无 server） | 需自造 origin（如 `https://local.invalid/`）——**自定义 scheme/假 https origin 在 Chromium 里不被当安全源**，localStorage/cookie 行为未定义且随版本变 | ⚠️ 不可靠 | ✅ | 同左 | ❌ origin 合法性无保证 |
| **D. androidx.webkit `WebViewAssetLoader`** | **`https://appassets.androidplatform.net/assets/`**（Google 预留域，Chromium 内核特判为本地资源） | ✅ 持久（落在 `app_webview/` 按 origin 分目录） | ✅ 相对 URL 按 origin 解析，`img/x.png` → `/assets/img/x.png` → 拦截命中 | 该域响应无额外 CSP 头；`index.html` 本身没有 CSP meta（已核实 index.html 全文 36 行） | ✅ **选定** |

### 3.2 选定方案 D 的落地参数

- `WebViewAssetLoader.Builder().addPathHandler("/assets/", AssetsPathHandler(context)).build()`
- 加载 URL：`https://appassets.androidplatform.net/assets/index.html`
- assets 由 `android/app/build.gradle.kts` 的 `sourceSets["main"].assets.srcDir("../../web")` 提供（路径推演见 PLAN.md §5.1），APK 内即 `assets/index.html`、`assets/data.js`、`assets/img/…`。
- `AssetsPathHandler` 用 `AssetManager.open()` 流式返回，压缩条目（如 8.8MB 的 `data.js`）也可读；PNG/JPG 本来就不会被 aapt2 再压。
- WebView 设置（MainActivity 内，逐项给理由）：
  - `settings.domStorageEnabled = true` —— localStorage 必需；
  - `settings.javaScriptEnabled = true`；`settings.cacheMode = LOAD_DEFAULT`；`settings.mediaPlaybackRequiresUserGesture` 与 iOS `mediaTypesRequiringUserActionForPlayback = .all` 对齐（本 App 无音视频，防御性）；
  - 不开 `allowFileAccess`（保持默认关闭，页面不需要）；
  - `settings.userAgentString` **不改 WebView 的 UA**——iOS 侧也没改 WKWebView 的 UA，只改了桥内 URLSession 请求的 UA；桥内 UA 见 §4.6；
  - `setSupportMultipleWindows(false)`（默认）：`target=_blank`/`window.open` 的导航会走 `shouldOverrideUrlLoading`，从而被外链逻辑接管（对齐 iOS `createWebViewWith` 里"弹系统浏览器并返回 nil"）。

### 3.3 与 iOS 的差异说明（审阅点）

- iOS 是 `file://` + `loadFileURL(allowingReadAccessTo:)`；Android 因 localStorage 持久化要求换 https 伪域。这是两端唯一有实质差异的基础设施决策，其余全部尽力逐项对齐。
- 副作用：页面 origin 变化让 `history.pushState` 在 Android 上**一定可用**（iOS file:// 下 `app.js:855` 是 try/catch 包着的，可能抛异常被吞掉），所以 Android 的返回栈行为只会更规范。

## 4. 桥接实现细节

### 4.1 双层结构总览

```
sync.js / update.js                （web 侧，零改动）
   │ window.webkit.messageHandlers.ba.postMessage(payload)
   ▼
[注入的 BridgeShim.SCRIPT]          （页面加载前生效，§4.2）
   │ __baNative.rpc(JSON.stringify(payload))
   ▼
BaBridge.rpc(json)                  （@JavascriptInterface，JavaBridge 线程）
   │ 解析 {id, op, ...}
   ├─ op=fetch → 白名单校验 → io 线程 HttpURLConnection → {status, bytes}
   └─ op=store → io 线程读写 filesDir/ba-sync-store.json → {status}
   ▼
webView.post { evaluateJavascript("window.__baRPC && window.__baRPC('<id>',<status>,'<b64>')") }
```

### 4.2 注入时机与 shim 形态（关键设计）

问题：`web/sync.js:26-28` 的 `hasBridge()` 检查 `root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.ba`，且 `sync.js` 在 `app.js` 之前、`<script>` 顶层立即执行（index.html:30-34）。shim 必须在**任何业务脚本之前**完成。

排除的方案：

- `onPageStarted` + `evaluateJavascript`：与页面脚本存在竞态（尤其页面有缓存时），不保证先于 `data.js`/`sync.js`。
- `WebViewCompat.addDocumentStartJavaScript`：语义正确，但依赖 WebView 的 `DOCUMENT_START_SCRIPT` 特性（androidx.webkit 1.8+ 且系统 WebView 版本达标），在旧 WebView 上静默失效，需要第二套兜底——不如直接用必然生效的那套。
- 改 `web/sync.js` 的 `hasBridge()`：违反零改动约束。

**选定**：AssetServer 在 `shouldInterceptRequest` 拦截 `/assets/index.html`（以及路径为 `/assets/` 或 `/assets` 的根请求）时，读出 `assets/index.html`（UTF-8 文本，仅 36 行），做一次字符串替换：把第一次出现的 `<head>` 换成 `<head><script>{BridgeShim.SCRIPT}</script>`，缓存结果字节，返回 `WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(...))`。HTML 里第一个 `<script src>` 在 `</body>` 前（data.js），插入点在最前面，**确定性早于一切脚本**，且不改 `web/` 任何文件。

shim 源码形态（`BridgeShim.SCRIPT`，压缩为一行）：

```js
(function(){
  var w = window;
  if (w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.ba) return;
  var n = w.__baNative;
  if (!n) return;
  w.webkit = { messageHandlers: { ba: { postMessage: function(msg){
    try { n.rpc(JSON.stringify(msg)); } catch(e) {}
  } } } };
})();
```

要点：

- `__baNative` 由 `addJavascriptInterface(baBridge, "__baNative")` 暴露；JS Interface 对象在**文档任意脚本开始前即可用**（Chromium 的 JS Bridge 注入点在文档创建时），所以 shim 在 `<head>` 里一定能拿到它。
- `postMessage` 的 payload 是纯 JSON 值（sync.js 只传 string/number 字段），`JSON.stringify` 往返无损。
- `postMessage` 内部 try/catch：iOS WKScriptMessage 不会因回调抛错影响页面，Android 侧也不让原生异常冒泡到 JS。
- 命名带 `__` 前缀且不与页面全局冲突（已核对 `sync.js`/`update.js` 的全局：`__baRPC`、`BASync`、`BAFetch`，无 `__baNative`/`webkit` 占用冲突——页面从不自建 `webkit`）。

### 4.3 原生端解析与分发

`BaBridge.rpc(json: String)`（JavaBridge 线程进入）：

1. `JSONObject(json)`，取 `id`（String）、`op`（String，缺省按 iOS 逻辑当 "fetch"，见 WebShell.swift:55）。
2. `op == "store"` → `handleStore(id, obj)`，转 io 线程。
3. 否则按 fetch：取 `url`、`headers`（JSONObject → Map）。**校验（与 WebShell.swift:61-68 完全一致，顺序也一致）**：
   - url 可解析、`url.host` 小写后 ∈ allowedHosts；
   - `url.scheme` 小写 == `https`；
   - 任一不满足 → 直接回 `__baRPC(id, 0, '')`，不发请求。
4. 校验通过 → `io.execute { doFetch(...) }`。

### 4.4 fetch 的网络实现

- 用 `HttpURLConnection`（零额外依赖；OkHttp 不在依赖最小化清单里）。
- `connectTimeout = 25_000`、`readTimeout = 25_000`（对齐 `request.timeoutInterval = 25`；Chromium 侧 JS 还有 40s 自杀计时器 sync.js:57-59，不会比原生先炸）。
- 请求头：先设 `User-Agent: <§4.6 的固定串>`，再覆盖式写入 JS 传来的 `headers`（与 iOS `setValue` 顺序一致：自定义头可覆盖 UA）。
- 响应：`status = connection.responseCode`（异常/无响应 → status=0，body 空）；`body = inputStream 读完`（错误流也读，但 body 不回传也无妨——iOS 把 data 原样回传；对齐：**成功与否都回传读到的 bytes**）。
- 任何异常（含超时、重定向到非白名单 host——`HttpsURLConnection` 默认跟重定向，跟随后的最终 host 不再校验）→ status=0。注：iOS URLSession 同样跟随重定向且不再校验，行为对齐，不额外收紧。

### 4.5 回复与转义

统一出口：

```kotlin
fun reply(webView: WebView, id: String, status: Int, bytes: ByteArray?) {
    val b64 = if (bytes == null) "" else Base64.encodeToString(bytes, Base64.NO_WRAP)
    val js = "window.__baRPC && window.__baRPC('${BridgeShim.jsStringLiteral(id)}', $status, '$b64');"
    webView.post { webView.evaluateJavascript(js, null) }
}
```

- **`Base64.NO_WRAP` 是硬性要求**：默认 base64 每 76 字符插 `\n`，放进单引号 JS 字符串直接 SyntaxError；iOS `Data.base64EncodedString()` 不换行，必须对齐。
- `jsStringLiteral`：转义 `\`、`'`、换行、`\u2028/\u2029`。id 由 JS 生成（sync.js:47 `String(++seq)`），理论上是纯数字，但按不可信输入处理。
- `status` 是 Int，直接内插。
- 回复必须 `webView.post{}`：`evaluateJavascript` 只能在主线程；网络回调在 io 线程。
- base64 是 ASCII 安全字符集（`A–Za–z0–9+/=`），无需转义。
- 大 body（同步立绘，数百 KB）经同一通道；单条 `evaluateJavascript` 在 Chromium 中字符串上限远高于此，v1 不分块。这是与 iOS 完全同构的负载形态。

### 4.6 与 iOS 行为对齐表（审阅用）

| 项 | iOS（WebShell.swift） | Android（本设计） | 一致 |
| --- | --- | --- | --- |
| JS 调用入口 | `webkit.messageHandlers.ba.postMessage` | shim 伪造同一路径 → `__baNative.rpc` | ✅（web 零改动） |
| 回调 | `window.__baRPC && window.__baRPC(id,status,b64)` | 同左，逐字符同构 | ✅ |
| id 类型 | String | String | ✅ |
| op 缺省值 | `"fetch"`（:55） | `"fetch"` | ✅ |
| allowedHosts | 上述 4 域 | 同 4 域（逐字照抄，小写比较） | ✅ |
| scheme 限制 | 仅 https | 仅 https | ✅ |
| 非法请求回包 | status=0, body 空 | 同 | ✅ |
| UA | `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1` | 逐字符相同（常量 `BaBridge.UA`） | ✅ |
| 超时 | `timeoutInterval = 25` | connect+read 各 25s | ✅（量级一致） |
| 附加 headers | 自定义头逐个 `setValue`（可覆盖 UA） | 同 | ✅ |
| HTTP 状态 | `HTTPURLResponse.statusCode ?? 0` | `responseCode`，异常→0 | ✅ |
| store·save | 忽略 key，写 `Documents/ba-sync-store.json`，原子写，成功回 `200`+空 body，失败回 `500`+空 | 忽略 key，写 `filesDir/ba-sync-store.json`，临时文件+rename 原子写，回包同 | ✅ |
| store·load | 读不到回 `200`+空 body；读到回 `200`+文件字节 | 同（IOException → 空 body 的 200） | ✅ |
| 线程 | URLSession 后台回调 → 主线程 evaluateJS | io 线程 → `webView.post` evaluate | ✅ |
| 空数据 base64 | `""` | `""` | ✅ |

唯一刻意差异：Android 无 `data == nil` 与空 `Data` 的区分需求（iOS 两者都回 `""`，Android 同样合并）。

### 4.7 错误码汇总

| status | 含义 | 来源 |
| --- | --- | --- |
| 0 | 网络失败 / URL 非法 / host 不在白名单 / 非 https / JSON 解析失败 | 对齐 iOS |
| 200 | fetch 成功；store 成功（save 成功 body 为空、load body 为文件内容） | 对齐 iOS |
| 其他 | 上游 HTTP 状态码原样透传 | 对齐 iOS |
| 500 | store·save 写文件失败 | 对齐 iOS（iOS catch → 500） |

JS 侧消费方式（`sync.js:63-70`）：`status===0` → `Error('network')`，`status!==200` → `Error('http-N')`，`text.charAt(0)==='<'` → 反爬页。原生不需要再发明错误体。

### 4.8 更新检查（update.js 的链接去向）

`web/update.js:64-83` 的 `check()` 走 `BAFetch.json('https://api.github.com/repos/MilkTea0329/ba-student-dex/releases/latest')`（同一座桥），有新版本时返回的 `url` 是 **Release 页面链接 `rel.html_url`（github.com 网页，不是 ipa 直链）**。页面上的更新弹窗点"下载"即导航到该 http(s) URL——这条导航**不是**本 origin，会被 `DexWebViewClient.shouldOverrideUrlLoading` 的外链规则接住，交给系统浏览器打开（§7 外链逻辑 / PLAN.md M3 完成标准第 4 条）。结论：**无需改 `web/`，也不需要原生侧感知 Release 语义**；桥对 `api.github.com` 的放行（白名单第 4 项）就是 Android 端唯一要做的事。iOS 侧行为同构（`UIApplication.shared.open` 弹 Safari）。

### 4.9 调试开关（debug 构建）

`MainActivity.onCreate` 中：

```kotlin
if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
```

- 用途：M2/M4 验收要通过 CDP（`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` → Chrome `http://127.0.0.1:9222`）读 DOM、执行 `!!window.webkit…` 探针、检查 `localStorage`（`ba.dex.favs`）。没有这个开关，上述验收全部做不了。
- 它是**静态全局**开关，务必用 `BuildConfig.DEBUG` 门控，release 自动为 false，不引入泄漏面。

## 5. 存储设计（与 iOS 文件语义对齐）

- 文件：`context.filesDir/ba-sync-store.json`。iOS 用 `Documents/`（用户可见、可备份），Android `filesDir` 是语义等价物（应用私有、卸载即删）；`getExternalFilesDir` 不用。
- 内容：**不是** key→value 映射，就是 sync.js 传来的 `value` 原文（`JSON.stringify(ov)` 的整段 JSON：`{students, index, stamps, updatedAt, count, lastCheck…}` 结构）。iOS 忽略 `key`（WebShell.swift:87-101 从不读 key），Android 同样忽略——**不要**"好心"实现成多 key 存储，那会导致与 iOS 数据语义分叉。
- 写：`tmp = File(filesDir, "ba-sync-store.json.tmp")` → 写 UTF-8 → `renameTo`（同分区 rename 原子，对齐 `.atomic`）。写失败 → status 500。
- 读：不存在/损坏 → 返回空 body + 200（sync.js `loadOverlay` 会把空文本解析为 null 并走无 overlay 路径，`sync.js:78-87`）。
- 备份规则：v1 不做 `android:allowBackup` 特殊处理（保持 manifest 默认不声明，即跟随工程默认；若未来开启 backup，此文件 56KB 级无压力）。
- localStorage（收藏 `ba.dex.favs`、排序 `ba.dex.sort`）由 WebView 自己持久化在 `app_webview/` 下，按 `https://appassets.androidplatform.net` origin 分目录，卸载即清——与 iOS 行为（重签即清）体验一致，无需原生干预。

## 6. 生命周期

### 6.1 Activity 与 WebView

- `MainActivity` 竖屏锁定（`screenOrientation="portrait"`，对齐 iOS `UIInterfaceOrientationPortrait` 单值）。
- `android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboardHidden|density|uiMode"`：**任何配置变更都不重建 Activity**。理由：重建 = 重载 56MB / 3889 文件页面（3–5s 白屏回到首页），其中 `uiMode`（深浅色切换）与 `density` 是最可能发生的两项。`onConfigurationChanged` 里由 InsetsController 重算状态栏图标色与窗口背景。
- 进程重建（系统杀进程）：v1 **不做** `webView.saveState/restoreState`。SPA 的入口就是首页；收藏/排序在 localStorage、同步 overlay 在 filesDir，均无损。冷启动成本可接受（预算见 §10）。
- WebView 实例随 Activity 生灭，单实例，无复用池；`onDestroy` 中 `webView.destroy()`（先 `removeAllViews` 防泄漏）。

### 6.2 onPause / onResume

```kotlin
override fun onPause() { webView.onPause(); super.onPause() }   // 暂停渲染/布局，不动 JS 定时器
override fun onResume() { super.onResume(); webView.onResume() }
```

- **不调用** `webView.pauseTimers()`：它是进程级全局暂停，会冻结 JS（包括后台同步的 Promise 链、40s 超时器），且忘记成对恢复是经典事故源。iOS 侧后台同步也是"退到后台即停、回前台继续"的自然行为，`onPause()` 级别的暂停与其等价。
- `onStop` 不做额外事；系统按需冻结进程。

### 6.3 渲染进程崩溃恢复（onRenderProcessGone）

页面常驻约 56MB 图片解码与 JS 堆，低内存下 Chromium 渲染进程可能被杀。策略：

- `DexWebViewClient` 覆写 `onRenderProcessGone(view, detail)`：
  1. `detail.didCrash()` 为 false（系统主动回收）时，**不要**再调用 `view.destroy()` 之外的任何 WebView API（官方文档明确：渲染进程死后 WebView 实例不可再用，任何调用可能再崩）；
  2. `webView.removeAllViews(); webView.destroy()`，置空引用；
  3. 重建：`MainActivity` 把"创建 WebView + BaBridge 挂接 + InsetsController 挂接 + 加载入口 URL"封装成一个 `rebuildWebView()`（`onCreate` 与此共用），重新 setContentView/挂树；
  4. 返回 `true`（表示应用已自行处理，阻止系统级崩溃对话框）。
- 数据面无损：收藏在 localStorage（`app_webview/`，按 origin 持久，与 WebView 实例无关）、同步 overlay 在 `filesDir`、内置数据在 assets——重建即完整恢复，只是回到首页（SPA 无可恢复的深链状态）。
- 不做的事：不统计崩溃率、不做多级重试（第二次崩溃由系统自然处理）；重建瞬间窗口背景色（§8.1）兜底避免闪白。

### 6.4 WebView 复用与内存策略

- **单实例、随 Activity 生灭，不做跨 Activity 复用/池化**：App 只有一个 Activity，复用池是无收益的复杂度。
- `onDestroy` 顺序（防 Window 泄漏的经典坑）：先从视图树 `removeAllViews()`，再 `webView.destroy()`；`BaBridge` 持 webView 用**弱引用**，渲染线程未完成的回调在 Activity 销毁后自然落空。
- 主进程与渲染进程分离：JS 堆（8.8MB data.js 解析产物）与图片解码缓存都在 `:sandboxed_process` 渲染进程，主进程内存预算很小（§10）。不调 `setMemoryCacheSize` 等（WebView 按系统内存分级自管）。

## 7. 返回栈与左边缘手势共存

### 7.1 返回键

```kotlin
onBackPressedDispatcher.addCallback(this) {
    if (webView.canGoBack()) webView.goBack() else finish()
}
```

- `webView.goBack()` ⇔ `history.back()`，触发 `popstate`，`app.js:865-867` 里 `closeDetail()`。这与 iOS 的"WKWebView 不拦截、App 关闭按钮/手势各自走 history 或直关"行为在结果上对齐。
- 已知怪癖（**与 iOS 一致，不修**）：`app.js:955` 点页面内"返回"按钮直接 `closeDetail()`，不回退 history → 留下一个悬空 entry；此时按系统返回键 → popstate → `closeDetail()` no-op → 需再按一次才退出。iOS 端同样存在（`WebShell.swift` 无任何 history 干预）。验收清单如实标注。
- manifest 不开 `android:enableOnBackInvokedCallback`（predictive back 动画对本 App 无收益且增加验证面）；`OnBackPressedDispatcher` 在两种模式都正确工作。

### 7.2 左边缘手势（与系统手势的冲突）

`app.js:871-946` 的 JS 手势：详情页时，左缘 30px 内 touchstart、右滑 translateX、松手按位移/速度判定返回。冲突点：Android 10+ 系统返回手势同样从左右边缘触发，系统会先吃掉 touch 流。

对策（InsetsController 内，API 29+）：

```kotlin
// webView 布局完成后：
val strip = Rect(0, 0, (32 * resources.displayMetrics.density).toInt(), webView.height)
webView.setSystemGestureExclusionRects(listOf(strip))
```

- 32dp ≈ JS 的 30px 逻辑像素阈值（页面 viewport width=device-width，CSS px ≈ dp）。
- 系统对每条边的手势排除有总量上限（文档口径约 200dp 边长），全高 32dp 条带可能只部分生效；M3 在模拟器实测并记录（风险 R7/R10）。
- 不排除右缘（页面没有右缘手势，保留系统 back 手势的其他触发区）。
- 低于 API 29 的设备：无系统手势可言（三键导航），无冲突。

## 8. 主题 / 安全区 / 状态栏 / 启动画面 / 图标

### 8.1 主题与深色

- `res/values/themes.xml`：parent `Theme.Material.Light.NoActionBar`（或 `android:Theme.Material.Light.NoActionBar`，不引 appcompat 主题以省依赖——见 §9.2 依赖权衡）；`android:windowBackground=@color/bg_light`（`#EEF3FA`，iOS `UIColor(red:0.933,green:0.953,blue:0.980)` 与 `styles.css --bg` 同色）。
- `res/values-night/themes.xml`：`android:windowBackground=@color/bg_dark`（`#0B1220`，styles.css 深色 `--bg`）。
- 窗口背景必须与页面 `--bg` 同色：避免冷启动瞬间与 WebView 首帧之间的闪白/闪黑（iOS 侧同一手段，WebShell.swift:137 + StudentDexApp.swift:9）。
- `uiMode` 在 `configChanges` 中 → 深浅切换不重建；`onConfigurationChanged` + insets 回调里调 `syncChrome(night)`：`WindowInsetsControllerCompat(...).isAppearanceLightStatusBars = !night`（浅色页面用深色图标，对齐 iOS `UIStatusBarStyleDefault` 语义），并确保 `window.statusBarColor`/`navigationBarColor` 保持透明（edge-to-edge 下让页面内容透到系统栏后面）。

### 8.2 安全区（InsetsController）

- `enableEdgeToEdge()`（androidx.activity）统一入口，API 34/35 行为一致（Android 15 强制 edge-to-edge，我们主动启用以免行为随 targetSdk 漂移）。
- `ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->`
  `val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())`
  - `applyCssVars(sys.top, sys.bottom)`：`evaluateJavascript("document.documentElement.style.setProperty('--safe-t','${sys.top}px');document.documentElement.style.setProperty('--safe-b','${sys.bottom}px');")`——与 WebShell.swift:12-13 逐字同构。行内样式优先级高于 `styles.css:23-24` 的 `env()` 默认值，Android WebView 的 `env(safe-area-inset-*)` 恒为 0 也不影响。
  - `ime`：`val ime = insets.getInsets(WindowInsetsCompat.Type.ime())`；搜索框聚焦时给 `webView.translationY = -ime.height.toFloat()`（模拟 adjustResize 的视觉；edge-to-edge 下 adjustResize 对 WebView 失效是已知平台行为）。IME 收起时归零。
  - 返回 `WindowInsetsCompat.CONSUMED`（WebView 自己消费 systemBars 无意义，我们要的是反射进 CSS）。
  - 首次注入竞态：insets 回调可能早于页面 DOM ready——`DexWebViewClient.onPageFinished` 再 replay 一次（对齐 iOS `didFinish` 里的重复注入，WebShell.swift:191-196）。
- `dispatchApplyWindowInsets` 期间 WebView 全屏 match_parent，无 fitsSystemWindows。

### 8.3 启动画面

- 不引 splashscreen 兼容库。Android 12+ 系统默认 splash（居中图标 + windowBackground 色）即够用，窗口背景色（§8.1）保证 splash → WebView 首帧之间无色跳；页面自带 `#boot` 转圈动画（index.html:18-22）覆盖 data.js 解析期。
- iOS 的 `UILaunchScreen.UIColorName=LaunchBackground` 对应物就是 windowBackground，语义对齐。

### 8.4 图标

- 源：`web/icon.png`（512×512，manifest.json 已声明 `sizes: 512x512`；仓库另有 `icon-192.png`）。**不**用 iOS Assets.xcassets（避免引 Apple 目录结构）。
- 生成方式（一次性，产物提交 git）：
  ```
  # 机器上无 ImageMagick 时用 Python/Pillow（harness 自带 Python 含 Pillow）
  python -c "from PIL import Image; im=Image.open('web/icon.png'); [im.resize((s,s), Image.LANCZOS).save(f'android/app/src/main/res/mipmap-{d}/ic_launcher.png') for s,d in [(48,'mdpi'),(72,'hdpi'),(96,'xhdpi'),(144,'xxhdpi'),(192,'xxxhdpi')]]"
  ```
  （目录需先 `mkdir -p`；这段命令只读 `web/`、只写 `android/res/`，不违反零改动约束。）
- v1 不做 Adaptive Icon（前景/背景分层需要抠图，收益仅圆形遮罩下的观感）；启动器会自动把位图裁圆/裁方。升级路径记入"不做"清单。
- manifest：`android:icon="@mipmap/ic_launcher"`、`android:label="@string/app_name"`（`什亭之匣`）。

## 9. 构建配置

### 9.1 SDK / 版本

| 项 | 值 | 理由 |
| --- | --- | --- |
| compileSdk | 35 | 本机 SDK 只有 platform android-35；AGP 8.7.3 官方支持 |
| targetSdk | 35 | edge-to-edge 行为确定性（配合 §8.2 主动 enableEdgeToEdge）；WebView 特性以系统 WebView 为准不受 targetSdk 影响 |
| minSdk | 24 | androidx.webkit 最低 21，但 API<24 设备系统 WebView 基本停止更新；`styles.css:77` 用了 `color-mix()`（Chromium 111+，上一行有 rgba 兜底），`app.js` 为 ES5+少量现代 API。24（Android 7.0）覆盖 >95% 存量且"WebView 已可经 Play 更新"前提成立。**明示约束：需系统 WebView ≥ 111** |
| versionName | "1.0.1" | 对齐 iOS MARKETING_VERSION |
| versionCode | 1 | 对齐 CURRENT_PROJECT_VERSION=1 |
| applicationId | `com.sensei.studentdex` | 对齐 iOS PRODUCT_BUNDLE_IDENTIFIER（同包名便于未来两端互通识别；非上架故无冲突顾虑） |

### 9.2 依赖（刻意最小化）

```
androidx.core:core-ktx:1.15.0        // WindowInsetsCompat / WindowInsetsControllerCompat
androidx.activity:activity-ktx:1.9.3 // AppCompatActivity 非必需，但 enableEdgeToEdge 与 OnBackPressedDispatcher 由此提供
androidx.webkit:webkit:1.12.1        // WebViewAssetLoader
org.jetbrains.kotlin:kotlin-stdlib   // Kotlin 2.0.21
```

不引：OkHttp（HttpURLConnection 足够，见 §4.4）、appcompat 主题（用平台 Material 主题）、Compose、协程（桥是单回调模型，ExecutorService + Handler 足够且更贴 WebView 线程模型）。

### 9.3 工程骨架

- `android/settings.gradle.kts`：`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }`、`dependencyResolutionManagement { repositories { google(); mavenCentral() } }`、`include(":app")`、插件版本 `id("com.android.application") version "8.7.3"`、`id("org.jetbrains.kotlin.android") version "2.0.21"`。
- `android/app/build.gradle.kts` 关键段：
  ```kotlin
  android {
      namespace = "com.sensei.studentdex"
      compileSdk = 35
      defaultConfig {
          applicationId = "com.sensei.studentdex"
          minSdk = 24; targetSdk = 35
          versionCode = 1; versionName = "1.0.1"
      }
      sourceSets { getByName("main") { assets.srcDir("../../web") } }  // 路径推演见 PLAN.md §5.1
      buildTypes {
          release { isMinifyEnabled = false /* 未签名产物 */ }
          debug   {}   // 默认 debug.keystore
      }
  }
  ```
- `gradle.properties`：`android.useAndroidX=true`、`org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8`。
- 无 Gradle wrapper（构建命令固定 `D:/harness/.build-env/gradle-8.14.5/bin/gradle -p android <task>`；理由与补救见 PLAN.md §6）。
- proguard（仅 release 生效）：`-keepclassmembers class com.sensei.studentdex.BaBridge { @android.webkit.JavascriptInterface <methods>; }`。

### 9.4 Manifest 要点

```xml
<application android:label="@string/app_name" android:icon="@mipmap/ic_launcher"
             android:theme="@style/AppTheme" android:allowBackup="false">
  <activity android:name=".MainActivity" android:exported="true"
            android:screenOrientation="portrait"
            android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboardHidden|density|uiMode"
            android:windowSoftInputMode="adjustResize">
    <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
  </activity>
</application>
```

- 无 INTERNET 之外的权限需求？**需要 `<uses-permission android:name="android.permission.INTERNET"/>`**（BaBridge 代发请求；WebView 加载本地资源不需要网络权限但桥需要）。清单里唯一权限。
- `allowBackup=false`：私有数据（收藏 localStorage 属 WebView 数据目录）不进云备份，对齐 iOS"重签即清"的低持久预期，语义简单。

## 10. 性能预算（LDPlayer14 口径，M4 实测）

| 指标 | 预算 | 测法 |
| --- | --- | --- |
| 冷启动（图标点按 → `#boot` 转圈出现） | ≤ 2.5s | `adb shell am start -W -n com.sensei.studentdex/.MainActivity` 的 TotalTime + 目测 |
| 首屏可交互（列表可滚动） | ≤ 6s（含 data.js 8.8MB 解析 + 281 卡片渲染；真机预期 ≤ 3s） | 录屏逐帧 / 手测 |
| 桥单次 RPC 往返（fetch github API） | ≤ 3s（网络 RTT 除外） | DevTools Console 计时 |
| App 主进程 PSS | ≤ 120MB | `adb shell dumpsys meminfo com.sensei.studentdex`（TOTAL PSS） |
| 含渲染进程总内存（浏览 5+ 详情后） | ≤ 350MB | 同上命令的完整输出（WebView 渲染进程单列） |
| APK 体积 | ≤ 60MB | `ls -l app-debug.apk`（assets ~56MB + 代码 ~3MB） |
| 深浅色切换重载 | 0（不允许重载页面） | `cmd uimode night yes/no` 后页面滚动位置不变 |

超预算的处置顺序：确认不是构建配置问题（assets 是否被意外双打包）→ 观察 data.js 解析耗时（属 web 侧，改它需走例外通道）→ 其余项回到 DESIGN 修订。

## 11. 明确的「不做」清单

1. 不重写任何 UI（无 Compose、无原生列表/详情页）。
2. 不改 `web/`、`StudentDex/` 及仓库根既有文件（例外通道见 PLAN.md §2）。
3. 不复制 56MB 资源（唯一资源通道 = `assets.srcDir("../../web")`）。
4. 不做多 key 的 store 抽象（严格复刻 iOS 单文件语义，§5）。
5. 不做 Adaptive Icon / 启动画面定制库（§8.3/§8.4）。
6. 不做 WebView 状态保存恢复（§6.1）。
7. 不做 OkHttp/协程/依赖注入框架（§9.2）。
8. 不做 release 签名、混淆、Play 上架准备。
9. 不做横屏/平板/折叠屏适配。
10. 不做 voice 音频播放、推送、账号系统（iOS 也没有）。
11. 不做 `pauseTimers()`、多进程 WebView、预加载/离线包差分更新。
12. 不为"修"返回栈悬空 entry 而 hack web 的 history（与 iOS 行为一致性优先，§7.1）。

---

## 12. 给实现者（Codex）的交接说明（DESIGN 部分）

**必须遵守的约束：**

1. 事实源优先级：`WebShell.swift` > 本文档 > 你的直觉。桥的每个常量（4 个 host、UA 整串、25s、status 语义、store 忽略 key）在 WebShell.swift 都有出处，抄它，别"优化"。
2. 三处最容易写错、错了最难查的点，逐条自查：
   - base64 必须 `Base64.NO_WRAP`（§4.5）；
   - shim 必须注入在 index.html 响应体里（`<head>` 后），保证先于 data.js/sync.js 执行（§4.2），**不要**用 onPageStarted+evaluateJavascript；
   - 回复 JS 的 `id` 必须过 `jsStringLiteral` 转义，`evaluateJavascript` 必须在主线程（`webView.post`）。
3. `settings.domStorageEnabled = true` 漏了 = 收藏不持久；`assets.srcDir("../../web")` 相对基准是 `android/app/` 目录，写错一层 APK 里就找不到 index.html（验证法：解包 APK 看 `assets/index.html` 路径，PLAN.md §5.1）。
4. 不要调用 `webView.pauseTimers()`；不要把 `uiMode` 从 `configChanges` 里漏掉（深浅切换重载页面是 P0 级体验事故）。
5. 外链判定只看"非本 origin 的 http(s)"就转 ACTION_VIEW；本 origin（`https://appassets.androidplatform.net`）一律放行。别按 host 白名单放行页面导航——那是桥的 fetch 白名单，两码事。
6. 文件清单就是 PLAN.md §5.2 的 7 个 Kotlin 文件 + res，不要新增"看起来有用"的类/抽象；依赖只有 §9.2 列的 3 个 androidx 库。
7. 构建命令：`D:/harness/.build-env/gradle-8.14.5/bin/gradle -p android assembleDebug`；安装：`D:/leidian/LDPlayer14/adb.exe -s emulator-5554 install -r android/app/build/outputs/apk/debug/app-debug.apk`。`local.properties`（`sdk.dir=D:/harness/.build-env/android-sdk`）不入 git。
8. 性能/行为存疑时先在 DevTools（`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`）里验证 JS 侧看到的世界，再怀疑原生侧。
9. 遇到"必须改 web 才能继续"的冲动：回到 PLAN.md §2 例外通道流程，先记录再动手，≤5 行纯 shim。
