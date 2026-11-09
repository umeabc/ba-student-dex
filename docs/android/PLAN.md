# 什亭之匣（StudentDex）Android 移植 · 实施计划

版本：v1（2026-11）
配套文档：[docs/android/DESIGN.md](DESIGN.md)（技术设计稿，本文档中所有"为什么"的论证都在那里）
对应 iOS 版本：V1.0.1（`StudentDex/project.yml` `MARKETING_VERSION: "1.0.1"`，bundle id `com.sensei.studentdex`）

---

## 1. 背景（已核实的仓库事实）

本 App 的本质是「**离线 Web SPA + 原生 WebView 外壳**」：

- iOS 侧全部原生逻辑只有两个文件：`StudentDex/Sources/WebShell.swift`（198 行：WKWebView 外壳、安全区反射、原生桥、外链转交 Safari）与 `StudentDex/Sources/StudentDexApp.swift`（19 行：SwiftUI 入口，`.ignoresSafeArea()` + 背景色 `#EEF3FA`）。UI 与业务全部在 `web/` 目录的纯静态页面里。
- 页面加载：`loadFileURL(Bundle.main … "Web/index.html")`，资源随包。
- 原生桥（唯一契约，`web/sync.js` 头部注释与 `WebShell.swift` 一致）：
  - JS → 原生：`window.webkit.messageHandlers.ba.postMessage({id, op:'fetch'|'store', …})`
  - fetch：`{id, op:'fetch', url, headers}`，仅允许 https + host ∈ {`www.gamekee.com`, `api-cdn.gamekee.com`, `cdnimg-v2.gamekee.com`, `api.github.com`}；UA 伪装 iPhone Safari（iOS 17.0）；超时 25s。
  - store：`{id, op:'store', action:'load'|'save', key, value}`，`value` 是整段 JSON 字符串；**iOS 实现忽略 key，固定读写单文件 `Documents/ba-sync-store.json`，原子写**。
  - 原生 → JS：`window.__baRPC(id, status, base64Body)`；status=HTTP 码，网络失败/参数非法为 0；body base64（网络错误时传空串）。
- 安全区：外壳把 `safeAreaInsets.top/bottom` 写进 `document.documentElement` 的 `--safe-t` / `--safe-b` CSS 变量（`styles.css` 的 `:root` 里默认是 `env(safe-area-inset-*)`，行内样式覆盖之）。
- 返回：`web/app.js` `openDetail()` 会 `history.pushState`，`popstate` 触发 `closeDetail()`；另有详情页左边缘 30px 内右滑跟手返回（纯 JS touch 实现）。
- 收藏只依赖 localStorage（`ba.dex.favs` / `ba.dex.sort`，`app.js` 有 file:// 下的内存降级）→ **Android 端必须让页面跑在一个可持久化的安全 origin 上，file:// 不可取**。
- 深色模式纯 CSS `prefers-color-scheme`（`styles.css` `@media (prefers-color-scheme: dark)`），外壳只负责窗口背景与状态栏图标颜色。
- 资源体量：`web/` 合计约 56MB（data.js 8.8MB、avatars 13MB、img 15MB、portraits 20MB），共 **3889 个文件**（`find web -type f | wc -l` 复核）；`web/` 里还有现成的 `icon.png`（512×512）与 `icon-192.png` 可用作应用图标。
- 仓库只有一个 upstream commit，Android 工程放入**新增的 `android/` 目录**，不触碰既有目录。

**移植策略一句话**：不重写 UI，不复制资源，写一个行为等价的 Android WebView 外壳 + 一个把 `../web` 零拷贝打进 APK 的 Gradle 配置 + 一个把原生桥伪装成 `webkit.messageHandlers.ba` 的注入 shim。

## 2. 目标与非目标

### 目标

1. Android 端功能与 iOS V1.0.1 等价：列表/搜索/筛选/排序/学院/收藏/详情全 Tab/语音/立绘/完全离线。
2. 原生桥行为逐项对齐 iOS（见 DESIGN.md §4 对齐表），`web/` 目录**一个字节都不改**即可工作。
3. 56MB 资源零拷贝打包：Gradle sourceSets 直接把 `../web` 作为 assets 源目录，仓库里不出现资源副本。
4. 在雷电模拟器 LDPlayer14（Android 14 / API 34 / WebView 146，`emulator-5554` 已连接）上完成全部验证。
5. 产出可安装的 debug APK（release 未签名构建可选）。

### 非目标

- 不改 `web/` 的任何业务代码、不改 `StudentDex/` iOS 工程、不改仓库根的 README 等既有文件（允许**新增** `android/`、`docs/android/`）。
- 不做 Android 原生 UI（不用 Compose 重写任何页面）。
- 不做 Google Play 上架准备（签名仅 debug；release 仅留未签名产物位）。
- 不做平板/横屏适配（iOS 侧 `UISupportedInterfaceOrientations` 锁竖屏，Android 同样锁定 `portrait`）。
- 不做增量更新/插件化下载资源——56MB 全量随包。
- 不做多进程/多 WebView。

### 必须改动 `web/` 时的例外通道

本计划 v1 **不需要**改 `web/`。若实现过程中发现某处必须改（例如某 API 在目标 WebView 上缺失导致 JS 报错），必须满足：改动 ≤ 5 行、纯兼容性 shim 性质（不改业务逻辑）、在 PLAN.md 验收清单中单列一行注明文件/行号/理由。除此之外一律禁止。

## 3. 总体技术路线（细节见 DESIGN.md）

| 决策点 | 结论 |
| --- | --- |
| 页面加载 | androidx.webkit `WebViewAssetLoader`，origin = `https://appassets.androidplatform.net/assets/`，`/assets/` 前缀映射 APK assets 根 |
| 资源打包 | `android/app/build.gradle.kts` 中 `sourceSets["main"].assets.srcDir("../../web")`（路径推演见 §5.1） |
| 桥 shim | 在 `shouldInterceptRequest` 返回 `index.html` 时向 HTML 注入一段脚本，伪造 `window.webkit.messageHandlers.ba`，转发到 `addJavascriptInterface` 暴露的原生对象 |
| 存储 | `context.filesDir/ba-sync-store.json`，语义与 iOS `Documents/ba-sync-store.json` 完全一致（单文件、忽略 key、原子写） |
| 安全区 | `enableEdgeToEdge()` + `OnApplyWindowInsetsListener` 反射 `--safe-t/--safe-b`，并在 `onPageFinished` 重放一次（对齐 iOS `didFinish`） |
| 返回 | `OnBackPressedDispatcher`：`webView.canGoBack()` → `webView.goBack()`（触发 popstate → closeDetail），否则 `finish()` |
| 外链 | `shouldOverrideUrlLoading`：非本 origin 的 http(s) → `Intent(ACTION_VIEW)` 转交系统浏览器 |
| 深色 | `values-night` 主题 + `uiMode` 加入 `configChanges`（切换深浅色不重建 Activity、不重载 56MB 页面） |
| 工程语言 | Kotlin + 传统 View（单 Activity，无 Compose，依赖最小化） |

## 4. 里程碑

每个里程碑的完成标准都包含**在雷电模拟器上的具体验证动作**。adb 一律使用 `D:/leidian/LDPlayer14/adb.exe -s emulator-5554`（下文简写 `adb`）。

### M0 · 环境与工程骨架（0.5 天）

内容：搭建 `android/` Gradle 工程，能出 APK、能装进模拟器。

- 新建 `android/settings.gradle.kts`、`android/build.gradle.kts`、`android/gradle.properties`、`android/local.properties`、`android/app/…`（文件清单见 §5）。
- `local.properties` 写 `sdk.dir=D:/harness/.build-env/android-sdk`（**不要**提交 git；见 §6）。
- MainActivity 暂时只显示一个空 WebView 或占位 TextView。
- 暂不接入 `../web` 资源。

完成标准：

1. `D:/harness/.build-env/gradle-8.14.5/bin/gradle -p android assembleDebug` 退出码 0（JDK 21 环境）。
2. `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` 成功。
3. `adb shell am start -n com.sensei.studentdex/.MainActivity` 启动无 crash（`adb logcat -s AndroidRuntime:E` 无新增）。
4. `git status` 显示只新增 `android/`、`docs/android/`，无既有文件改动。

### M1 · 页面加载 + 安全区 + 深色（1 天）

内容：WebViewAssetLoader + sourceSets 零拷贝资源 + InsetsController + 深色主题。

完成标准（模拟器）：

1. 启动 App 后**学生列表（281 人网格）完整渲染**，头像图片正常显示（说明 3889 个文件的 assets 打包与 `/assets/` 映射全部正确）。
2. `adb shell dumpsys window | grep -E "mCurrentFocus"` 确认聚焦的是本应用；页面顶部标题不与状态栏重叠（topbar 有 `calc(var(--safe-t) + 14px)` 间距），底部 tabbar 不被手势条遮挡。
3. 模拟器切换深色模式（设置 → 显示 → 深色模式，或 `adb shell cmd uimode night yes/no`）：页面 CSS 立即切换、**App 不重启、WebView 不重载**（logcat 无 reload 迹象），窗口背景与状态栏图标颜色同步切换。
4. 冷启动到列表可见 ≤ 5s（模拟器口径，作为 M1 观测值记录，正式预算在 M4 复测）。
5. 断网（模拟器关网络）后杀进程重启：一切照常（完全离线验证）。

### M2 · 原生桥（fetch + store）（1 天）

内容：BaBridge + HTML shim 注入 + filesDir 存储。

完成标准（模拟器）：

1. `adb forward tcp:9222 localabstract:webview_devtools_remote_"$(adb shell pidof com.sensei.studentdex)"` 后，用桌面 Chrome 打开 `http://127.0.0.1:9222`，在 Console 执行：
   ```js
   !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ba)
   ```
   返回 `true`（证明 shim 在 `sync.js` 之前生效）。
2. Console 再执行一次真实 RPC 往返：
   ```js
   window.__baRPC  // 应为 function
   ```
   并在 App 内触发「更多 → 立即同步WIKI数据」（README 常见问题表里引用的入口）：联网状态下能拉到 gamekee 数据。
3. 验证 store 落盘：同步执行后 `adb shell run-as com.sensei.studentdex ls -l files/` 能看到 `ba-sync-store.json`，`cat` 内容是 `{"students":…}` 结构的 JSON（与 iOS 同 key 同结构）。
4. 重启 App：新同步的学生仍带 `NEW` 角标（overlay 被正确读回）。
5. 版本更新检查：`api.github.com` 走同一桥，Console 无 `no-bridge` 报错；`update.js` 的降级路径（`BAFetch.available()` 为 false 时用普通 fetch）不应被触发。
6. 非法请求防护：Console 执行 `webkit.messageHandlers.ba.postMessage({id:'t1', op:'fetch', url:'https://evil.example.com/x'})`，随后 `__baRPC('t1', 0, '')` 风格的回调到达（status=0，拒绝）。

### M3 · 返回 / 手势 / 外链 / 生命周期（1 天）

完成标准（模拟器）：

1. 打开任一学生详情 → 按系统返回键 → 详情关闭回到列表（popstate 路径）；再按返回键 → App 退出。
2. 详情页左边缘 30px 内右滑：跟手拖动并返回列表（JS 手势生效，说明手势排除矩形生效或未与系统手势冲突）；记录实际效果到验收清单。
3. 同一详情页点页面内「返回」按钮后按系统返回键：**允许**出现"第一次 popstate 为空操作、第二次才退出"（这是 iOS 同款行为，`app.js` 的 `act === 'back'` 直接 `closeDetail()` 不回退 history），在清单中如实标注为"与 iOS 一致的已知怪癖"。
4. 外链：在"资料"Tab 点任何指向 gamekee/github 的链接 → 系统浏览器打开，App 停留原地不跳走。
5. Home 键切后台再回来：WebView 状态保留（不重载、滚动位置在）；App 内弹出的更新提示不受影响。
6. 开发者选项里开启"不保留活动"（或 `adb shell am kill com.sensei.studentdex`）后重启：冷启动路径正常，收藏仍在（localStorage 持久化验证）。

### M4 · 打磨与验收（1 天）

内容：图标/启动画面、性能预算复测、全量验收清单跑一遍、（可选）未签名 release 构建。

完成标准：

1. 桌面图标与名称「什亭之匣」正确（用 `web/icon.png` 生成 mipmap，方式见 DESIGN.md §8.4）。
2. 性能预算达标（口径见 DESIGN.md §10）：模拟器上冷启动 ≤ 5s、首屏可交互 ≤ 6s、`adb shell dumpsys meminfo com.sensei.studentdex` 的 PSS ≤ 350MB（滚动浏览若干详情后）。
3. §8 验收清单逐条打勾，全部通过（或标注"与 iOS 一致的已知差异"）。
4. `git add android docs/android` 提交，diff 中不包含任何 56MB 资源副本（`git diff --stat` 复核）。
5. （可选）`gradle -p android assembleRelease` 产出未签名 APK，记录到交付说明。

## 5. 任务拆解（文件级）

### 5.1 目录与路径推演

```
repo-ba-student-dex/
├─ android/                        ← 新增 Gradle 根
│  ├─ settings.gradle.kts
│  ├─ build.gradle.kts
│  ├─ gradle.properties
│  ├─ local.properties             ← sdk.dir=D:/harness/.build-env/android-sdk（不入 git）
│  └─ app/                         ← 唯一模块 :app
│     ├─ build.gradle.kts          ← 资源零拷贝配置在这里
│     ├─ proguard-rules.pro
│     └─ src/main/
│        ├─ AndroidManifest.xml
│        ├─ java/com/sensei/studentdex/
│        │  ├─ MainActivity.kt
│        │  ├─ DexWebViewClient.kt
│        │  ├─ BaBridge.kt
│        │  ├─ AssetServer.kt
│        │  ├─ InsetsController.kt
│        │  └─ BridgeShim.kt
│        └─ res/ …（见 §5.4）
├─ docs/android/PLAN.md、DESIGN.md  ← 本交付物
├─ web/                            ← 零改动、零复制
└─ StudentDex/                     ← 零改动
```

**路径推演（零拷贝的关键）**：`assets.srcDir` 的相对路径基准是**模块目录** `android/app/`。

- `android/app` 的上一级是 `android/`，再上一级是仓库根；
- 因此 `android/app/build.gradle.kts` 里写 `sourceSets["main"].assets.srcDir("../../web")`；
- 展开后即 `<repo>/web`，其内容（`index.html`、`data.js`、`img/`、`avatars/`、`portraits/`、`icon.png` 等）被映射到 APK 的 `assets/` 根；
- 运行时 `WebViewAssetLoader` 注册前缀 `/assets/` → `AssetsPathHandler(context)`（读 `context.assets` 根），故 URL `https://appassets.androidplatform.net/assets/index.html` ↔ `assets/index.html` ↔ 仓库文件 `web/index.html`。页面内的相对引用（`data.js`、`img/…png`、`manifest.json`）在同一 origin 下自然解析，无需任何改写。
- 注意：`srcDir` 指向的目录会被 Gradle 视为 assets 根本身，`web/` 内部没有多余的顶层包裹目录，所以**不需要** `../../web` 之外再拼子路径；若实现时发现映射多/少一层，用 `gradle -p android app:tasks` 无从判断，应直接解包 APK 验证：`unzip -l app-debug.apk | head` 应看到 `assets/index.html` 而不是 `assets/web/index.html`。

### 5.2 每个新文件的职责

| 文件 | 职责（单句边界） |
| --- | --- |
| `android/settings.gradle.kts` | 声明仓库根、模块 `:app`、插件版本（AGP 8.7.3 / Kotlin 2.0.21）、Google Maven + mavenCentral 仓库 |
| `android/build.gradle.kts` | 根级插件声明（`com.android.application` apply false 等），不放业务配置 |
| `android/gradle.properties` | `org.gradle.jvmargs=-Xmx3g`、`android.useAndroidX=true`、`kotlin.code.style=official` |
| `android/local.properties` | `sdk.dir=D:/harness/.build-env/android-sdk`（脚本生成或手写，git ignore） |
| `android/app/build.gradle.kts` | compileSdk/minSdk/targetSdk、applicationId/versionName/versionCode、依赖、**`assets.srcDir("../../web")`**、release 未签名配置、debug 签名用默认 |
| `android/app/proguard-rules.pro` | 仅保留 `@JavascriptInterface` 相关 keep 规则（防 release 混淆改名方法导致桥失效） |
| `android/app/src/main/AndroidManifest.xml` | 单 Activity、竖屏锁定、`configChanges`（含 `uiMode`）、`windowSoftInputMode="adjustResize"`、`usesCleartextTraffic` 不需要（桥仅 https）、应用名「什亭之匣」、图标 |
| `MainActivity.kt` | 唯一 Activity：创建/配置 WebView、注册返回回调、转发生命周期（onPause/onResume）、持有 BaBridge/InsetsController；不做业务判断 |
| `AssetServer.kt` | 封装 `WebViewAssetLoader`（`/assets/` 前缀 + `AssetsPathHandler`），并对 `index.html` 做 shim 注入（读 assets 中的 `index.html`，在 `<head>` 后插入 `BridgeShim.SCRIPT`，内存缓存改写后的字节，返回带 `text/html; charset=utf-8` 的 `WebResourceResponse`） |
| `BridgeShim.kt` | 常量对象：内嵌 shim JS 源码（伪造 `window.webkit.messageHandlers.ba` → `window.__baNative.rpc(JSON.stringify(msg))`）+ 原生侧 JS 回调的字符串转义工具 |
| `DexWebViewClient.kt` | `WebViewClient`：`shouldInterceptRequest` 委托 AssetServer；`shouldOverrideUrlLoading` 把非本 origin 的 http(s) 外链转 `Intent(ACTION_VIEW)`；`onPageFinished` 重放安全区变量注入 |
| `BaBridge.kt` | `@JavascriptInterface` 暴露 `rpc(json: String)`；解析 `{id, op, …}`，fetch 走 `HttpURLConnection`（host 白名单、UA、25s 超时、附加 headers），store 走 `filesDir/ba-sync-store.json` 原子读写；回复统一 `window.__baRPC('id', status, 'base64')`（base64 必须 `Base64.NO_WRAP`） |
| `InsetsController.kt` | 监听 `WindowInsetsCompat`（systemBars + displayCutout + ime），把 top/bottom 反射为 `--safe-t/--safe-b` 行内样式；同步状态栏图标明暗与窗口背景色；维护左缘手势排除矩形 |

### 5.3 Kotlin 源码之外的任务

- `web/icon.png` → `res/mipmap-{mdpi…xxxhdpi}/ic_launcher.png`（一次性生成，方式与命令见 DESIGN.md §8.4，产物**提交 git**，因为它是 res 而非 assets 拷贝，体积几十 KB）。
- `res/values/themes.xml`、`values-night/themes.xml`、`values/strings.xml`（`app_name=什亭之匣`）、`values/colors.xml`（`bg_light=#EEF3FA`、`bg_dark=#0B1220`）。
- `.gitignore`（`android/` 下新增）：`local.properties`、`build/`、`.gradle/`。

### 5.4 res 文件清单

```
res/
├─ values/{colors.xml, strings.xml, themes.xml}
├─ values-night/themes.xml
└─ mipmap-{mdpi,dpi…}(48,72,96,144,192) /ic_launcher.png ×5
```

不需要 drawable 适配图标前景层（v1 用普通 mipmap 位图，不做 Adaptive Icon；理由与升级路径见 DESIGN.md §8.4）。

## 6. 构建与签名方案

- **构建入口**：一律用 `D:/harness/.build-env/gradle-8.14.5/bin/gradle -p android <task>`（Windows Git Bash 下写 `/d/harness/.build-env/gradle-8.14.5/bin/gradle`），JDK 21。AGP 8.7.3 + Kotlin 2.0.21 走本地 Gradle 缓存，Google Maven 可访问（已核实）。
- **不生成 Gradle wrapper**：wrapper jar 需要额外联网分发，本机已固定 8.14.5；在 DESIGN.md 交接说明中注明"构建命令用绝对路径"。若日后需要可执行 `gradle -p android wrapper --gradle-version 8.14.5` 补上。
- **debug 签名**：使用 Gradle/AGP 默认 debug 签名（`~/.android/debug.keystore`，不存在时自动生成），零配置。
- **release**：`buildTypes.release` 不配 `signingConfig`（即产物未签名，`app-release-unsigned.apk`），`isMinifyEnabled=false`（体积大头是 assets，混淆收益极低且增加 `@JavascriptInterface` keep 心智负担）。release 为可选项，不阻塞任何里程碑。
- **local.properties 不入 git**；`android/.gitignore` 覆盖之。
- 增量构建注意：`assets.srcDir` 指向 3889 个文件后，`assembleDebug` 首次打包与资源变更后的重打包会明显变慢（预计 1–3 分钟），属预期，不要为提速去复制资源。

## 7. 风险清单与对策

| # | 风险 | 影响 | 对策（落到具体参数/文件） |
| --- | --- | --- | --- |
| R1 | **56MB / 3889 文件资源打包**：aapt2 处理慢；PNG/JPG 已压缩不会再压，`data.js`(8.8MB) 文本会被压缩，APK 仍 ~56MB；低端机解压流式读取慢 | 构建时间、安装体积、首载 | sourceSets 零拷贝（§5.1）；assets 不参与 aapt2 资源编译（不会 crunch PNG）；`WebViewAssetLoader.AssetsPathHandler` 用 `AssetManager.open()` 流式读取，兼容压缩条目；若首载实测慢，再评估 `androidResources.noCompress += listOf("js","css","html","json")`（只影响安装后读取速度，不改变正确性） |
| R2 | **WebView 版本差异**：`styles.css` 用了 `color-mix()`（Chromium 111+）、backdrop-filter 等；老设备系统 WebView 不达标则视觉降级或报错 | 兼容面 | minSdk 24 但明示"需要系统 WebView ≥ 111"（DESIGN.md §9.1）；`color-mix` 上一行已有 rgba 兜底（styles.css:76–77）；模拟器 WebView 146 满足；v1 不做运行时检测弹窗，记入 README 级已知约束 |
| R3 | **Android 14/15 edge-to-edge**：targetSdk 35 时新系统强制 edge-to-edge；不处理则内容钻到状态栏/导航栏下面 | 布局正确性 | 主动 `enableEdgeToEdge()`（行为跨版本一致），InsetsController 统一反射 `--safe-t/--safe-b`；对齐 iOS 的"行内样式覆盖 `:root` env()"方案；IME 场景见 DESIGN.md §8.3 |
| R4 | **localStorage / origin**：file:// 在 Android WebView 上 localStorage 不可持久 → 收藏丢失 | 核心功能 | 摒弃 file://（选型论证见 DESIGN.md §3）；`https://appassets.androidplatform.net/assets/` 是安全 origin，`settings.domStorageEnabled=true` 必须设置；M3 完成标准第 6 条专项验证杀进程后收藏仍在 |
| R5 | **桥接线程与 base64 大图**：`@JavascriptInterface` 在 JavaBridge 线程回调；同步图片（CDN 拉回的立绘 PNG，可达数百 KB）base64 后经 `evaluateJavascript` 注入，主线程拼大字符串可能卡顿 | 同步功能流畅度 | 网络与文件 I/O 派发到 `ExecutorService`；回复必须 `webView.post{}` 后再 `evaluateJavascript`（WebView 只允许主线程）；base64 用 `Base64.NO_WRAP`（换行符会破坏 JS 字符串字面量——iOS 的 `base64EncodedString()` 无换行，必须对齐）；单条回复体量与 iOS 相同，实测超阈值再考虑分块（v1 不做） |
| R6 | **data.js 解析耗时 / 首屏**：8.8MB JS 解析 + 生成 281 卡片 DOM，冷启动可能 3–5s | 体验 | 页面自带 `#boot` 加载动画（index.html:18–22）覆盖等待期；v1 不改 web；优化空间（如 `data.js` 拆分/延迟渲染）全部属于"改 web"范畴，列为非目标；性能预算口径见 DESIGN.md §10 |
| R7 | **返回键与左缘手势冲突**：Android 系统返回手势也从左缘触发，会吃掉 `app.js` 的 30px 左缘右滑；且 `app.js` 点"返回"按钮只 `closeDetail()` 不回退 history，留悬空 entry | 手势/返回体验 | 对左缘 ~32dp×全高调用 `setSystemGestureExclusionRects`（API 29+；系统对每边排除有上限约 200dp，可能部分生效，实测记录）；返回键统一走 `canGoBack()→goBack()`；悬空 entry 怪癖与 iOS 完全一致，验收时如实标注，不做 web 修改去"修复" |
| R8 | **深色模式状态栏**：`uiMode` 进 `configChanges` 后 Activity 不重建，若不手动更新状态栏图标颜色与窗口背景，会出现深色页面+浅色状态栏图标（或反之） | 视觉一致性 | `onConfigurationChanged` 中由 InsetsController 重算 `isAppearanceLightStatusBars` 与 `window.setBackgroundDrawable`；初始与每次 insets 变化时同步 |
| R9 | **进程被杀后 WebView 重建**：56MB 资源页面冷启动慢，若 configChanges 漏项导致意外 recreate 会出现"转圈半秒以上回到首页" | 体验 | `AndroidManifest.xml` 的 `configChanges` 覆盖 `orientation|screenSize|smallestScreenSize|screenLayout|keyboardHidden|density|uiMode`；v1 不做 WebView 状态保存（SPA 首页本就是入口，收藏在 localStorage） |
| R10 | **LDPlayer/模拟器特有差异**：x86、非标准 ROM，手势排除、predictive back 行为可能与真机不同 | 验证代表性 | 所有模拟器结论标注"LDPlayer14/Android 14 口径"；手势排除、edge-to-edge 两项在验收清单里标记"建议真机复验"，但不阻塞交付 |
| R11 | **gamekee 反爬 / 同步在模拟器上失败**：网络出口 IP、UA 校验等导致 M2 验证受阻 | 里程碑验证 | M2 完成标准第 1、2 条（hasBridge、RPC 往返、store 落盘）不依赖 gamekee 放行，先保证桥正确；同步成功与否单独记录，失败不算 M2 阻塞项（桥行为对齐 iOS 即达标） |

## 8. 验收清单（对应 README「功能」表逐条）

在 LDPlayer14 / Android 14 / WebView 146 上执行。"✅ 判据"列即 M4 验收时打勾的依据。

**README 功能表逐条：**

| README 条目 | 验证动作 | ✅ 判据 |
| --- | --- | --- |
| 学生：281 名学生网格、名称/日文名/英文名/外号搜索 | 打开 App；搜索框分别输入中文名、日文假名、英文、外号 | 网格完整无缺图；四种搜索均出正确结果 |
| 筛选：稀有度/学院/攻击/防御/站位/作用/战术/武器 8 维多选 | 展开筛选面板，逐维勾选组合 | 结果集正确，角标/计数正常 |
| 排序：实装日期/名称/稀有度 | 切三种排序 | 顺序变化正确，且重启 App 后记住（`ba.dex.sort`） |
| 学院：16 所学院分组浏览 | 切到学院 Tab | 16 组全部显示 |
| 收藏：一键收藏，本地保存 | 详情页点收藏 → 杀进程 → 重启 | 收藏状态保留（localStorage 持久） |
| 概览：简介/基础信息/地形/评测/场合/建议/技能速览 | 打开任一学生详情概览 | 与 iOS 截图（README docs/screenshots/detail.png）内容同级 |
| 技能：EX/普通/被动/辅助/子技能，LV1–LV10 逐级 | 切技能 Tab，拖 LV | 数值/COST/材料随等级变化 |
| 属性：初始→满级、装备词条、专武、能力解放、羁绊 | 切属性 Tab 检查 | 各小节渲染正常 |
| 养成：专武/爱用品/技能材料 | 切养成 Tab | 正常 |
| 资料：全名/假名/译名/…/同名角色跳转 | 切资料 Tab，点同名角色跳转 | 跳转能打开另一详情 |
| 语音：6 分类日文原文+中文翻译 | 切语音 Tab 各分类 | 文本齐全 |
| 立绘：多张立绘 | 切立绘 Tab 左右切换 | 20MB portraits 资源正常显示 |

**README「其他特性」逐条：**

| 特性 | 验证动作 | ✅ 判据 |
| --- | --- | --- |
| 完全离线 | 模拟器断网重启 App | 全功能可用 |
| 数据自动同步（NEW/更新角标） | 联网启动等待后台同步，或手动"立即同步" | 新学生带 NEW；`files/ba-sync-store.json` 生成且重启后仍在（若 gamekee 侧受阻，按 R11 只验桥） |
| 版本更新提醒 | 正常联网启动 | `api.github.com` 桥调用发生、无 `no-bridge`；（仓库当前 latest 即 1.0.1 时无弹窗属正常） |
| 手势：详情页左缘右滑返回 | 左缘 30px 内右滑 | 跟手拖动并关闭详情；若系统手势抢先，记录 R7 实测结论 |
| 深色模式：跟随系统，适配刘海与手势条 | `adb shell cmd uimode night yes/no` | 页面/窗口背景/状态栏图标三者同步切换，不重启不重载 |

**外壳专项（iOS 行为对齐）：**

| 项 | 判据 |
| --- | --- |
| 返回键 | 详情 → 返回键关详情；列表 → 返回键退出 App |
| 外链 | 点 http(s) 外链 → 系统浏览器打开，App 不跳走 |
| 安全区 | 竖屏下顶/底留白正确，无内容被系统栏遮挡 |
| 桥契约 | M2 完成标准 1–6 全过 |
| 版本 | versionName=1.0.1、applicationId=com.sensei.studentdex、桌面名「什亭之匣」 |
| 仓库卫生 | git diff 无 `web/`、`StudentDex/` 改动，无资源副本 |

---

## 9. 给实现者（Codex）的交接说明（PLAN 部分）

1. **你不写 web 代码，也不改 iOS 代码**。`web/`、`StudentDex/`、根 README 等在 diff 里必须保持零改动；资源不允许复制进 `android/`，唯一通道是 `assets.srcDir("../../web")`。
2. **每一步先跑通完成标准再前进**：M0 的四条标准没过之前不要写 M1 的代码。所有命令用文中写死的路径：gradle = `D:/harness/.build-env/gradle-8.14.5/bin/gradle`，adb = `D:/leidian/LDPlayer14/adb.exe -s emulator-5554`。
3. **不要臆测 iOS 行为，以 `WebShell.swift` 为唯一事实源**：host 白名单四个值、UA 字符串逐字符照抄（DESIGN.md §4.6 有原文）、超时 25s、store 忽略 key 固定单文件、status=0 表示网络/参数失败、回调 JS 是 `window.__baRPC && window.__baRPC('<id>', <status>, '<base64>')`。
4. **base64 必须 `Base64.NO_WRAP`**。带换行的 base64 塞进 JS 单引号字符串会直接语法错误，这是最容易踩且最难查的坑。
5. **shim 注入必须在 `sync.js` 之前执行**：用"改写 index.html 响应"的方式（AssetServer），不要依赖 `onPageStarted`+`evaluateJavascript`（有竞态），也不要动 `web/sync.js` 的 `hasBridge()`。
6. `local.properties` 含本机绝对路径，**不要提交**；`android/.gitignore` 必须先行。
7. 出现"看起来必须改 web/ 才能解决"的问题时：停下来，在 PLAN.md §2 例外通道登记（文件/行号/理由/≤5 行），不要悄悄改。
8. 验证一律以模拟器实测为准，不要以"代码看起来对"作为完成依据；logcat 的 `AndroidRuntime:E`、`chromium:E` 是你主要的排错窗口。
