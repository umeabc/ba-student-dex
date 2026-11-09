# Android 端复核与真机（模拟器）验证报告

- 复核对象：`android/`（Codex 实现）、`docs/android/{PLAN,DESIGN,REVIEW}.md`
- 验证环境：雷电模拟器 LDPlayer14，Android 14（API 34），系统 WebView 146，900×1600 @320dpi（dpr=2，CSS 视口 450×800）
- 结论：**可安装、可离线运行，功能与 iOS 1.0.1 对齐**；debug 签名产物，仅用于测试分发。

---

## 1. 产物

| 项 | 值 |
| --- | --- |
| APK | `dist/StudentDex-1.0.1-android-debug.apk`（`android/app/build/outputs/apk/debug/app-debug.apk` 的副本） |
| 体积 | 52,769,590 字节（约 50.3 MiB） |
| SHA-256 | `f3a21716c5214e6579a92e264427f2caa97c3a8a3e0fa6fdcf7abefa4f6f6825` |
| 包名 / 版本 | `com.sensei.studentdex` / versionName `1.0.1`、versionCode `1` |
| SDK | minSdk 24，targetSdk 35，compileSdk 35 |
| 标签 | 什亭之匣（launcher 图标来自 `web/icon.png`，5 档 mipmap） |
| 签名 | Gradle 默认 debug keystore（**不可上架/长期分发**） |

## 2. 构建与安装（本机复现）

```bash
# 构建（Gradle 8.14.5 + AGP 8.7.3 + Kotlin 2.0.21 + JDK 21）
cd android
D:/harness/.build-env/gradle-8.14.5/bin/gradle.bat :app:assembleDebug

# 安装并启动（雷电）
D:/leidian/LDPlayer14/adb.exe install -r app/build/outputs/apk/debug/app-debug.apk
D:/leidian/LDPlayer14/adb.exe shell am start -n com.sensei.studentdex/.MainActivity
```

`android/local.properties` 指向本机 SDK（`D:/harness/.build-env/android-sdk`），已 gitignore。

## 3. 验证矩阵（LDPlayer14 / Android 14 / WebView 146 实测）

| # | 项 | 动作 | 结果 |
| --- | --- | --- | --- |
| 1 | 冷启动 | `am start -W`（force-stop 后） | `TotalTime 1277ms`；281 张卡片可交互约 4–5s |
| 2 | 学生列表 | 打开 App | 281/281，头像全部本地加载 |
| 2.1 | 触摸滚动 | 手指上/下滑动列表 | 跟手滚动、惯性正常；顶栏 sticky、底栏固定；`scrollWidth == clientWidth` 无横向溢出；筛选面板打开时滚动锁定，关闭后恢复 |
| 3 | 搜索 | 输入「白子」 | 4 条命中（白子 / 白子*恐怖 等） |
| 4 | 筛选面板 | 点「筛选」 | 8 个维度、底部安全区留白正确；返回键关闭面板且不退出 |
| 5 | 学院 | 学院 Tab | 16 张学院卡；点入首个学院 → 56 名学生 |
| 6 | 详情 | 点卡片 | 7 个 Tab（概览/技能/属性/养成/资料/语音/立绘）全部渲染 |
| 7 | 立绘 | 立绘 Tab | 20MB portraits 资源正常显示（默认/无眼镜两张） |
| 8 | 收藏持久化 | 收藏 → `force-stop` → 重启 | `localStorage ba.dex.favs` = `[225984]`，重启后仍在 |
| 9 | 返回键 · 详情 | `input keyevent 4` | `#detail.in` 关闭，停留列表 |
| 10 | 返回键 · 根 | 再按返回 | 回到桌面（Activity finish）；进程被系统缓存 |
| 11 | 安全区 | CDP 读 `--safe-t/--safe-b` | `--safe-t: 24px`（状态栏 24dp，已按 density 换算）；`--safe-b: 0px`（本模拟器不占导航栏） |
| 12 | 深色模式 | `cmd uimode night yes/no` | 页面/状态栏图标/窗口背景同步切换，`matchMedia` 与内联变量均为深色，**无重载、无闪烁** |
| 13 | 页面 origin | CDP | `https://appassets.androidplatform.net`（安全源，localStorage 可持久） |
| 14 | 桥存活性 | CDP | `window.webkit.messageHandlers.ba` 存在，`__baRPC` 为 function，注入早于 `sync.js` |
| 15 | 桥 store | postMessage save/load | 落盘 `files/ba-sync-store.json`，内容与 JS 传入一致；load 回 200 + 原字节 |
| 16 | 桥 fetch · 白名单外 | `https://evil.example.com` | `status=0`、空 body（拒绝，未发请求） |
| 17 | 桥 fetch · GitHub | `api.github.com/.../releases/latest` | `status=200`，base64 正文可解析；`BAUpdate.check('V1.0.1')` → `hasUpdate:false` |
| 18 | 外链（target=_blank） | 资料 Tab「实装学生图鉴」真实点击 | 系统浏览器打开，App 停留原页（`onCreateWindow` 捕获） |
| 18.1 | 数据同步（真实） | 联网启动等待自动同步 | `files/ba-sync-store.json` 落盘 1.6MB 真实数据（含「真琴(泳装)」等未内置词条）；重启后列表出现「更新」角标 |
| 19 | 离线 | CDP `Network.emulateNetworkConditions(offline)` | 281 张卡片与图片仍正常（资源全在包内）；同步失败仅影响「更多」页状态文案 |
| 20 | 内存 | `dumpsys meminfo` | 主进程 PSS ≈ 101MB；渲染进程 RSS ≈ 260MB（56MB 资源 + 281 图） |
| 21 | 构建可重复 | 清理后重编 | BUILD SUCCESSFUL，APK 内 `assets/index.html`（无 `assets/web/` 多一层） |

> gamekee 接口在本机网络出口**时通时断**：曾成功同步并落盘 1.6MB overlay（角标生效），随后 TLS 握手失败。桥行为、落盘、失败降级与 UI 提示均已覆盖。

## 4. 复核阶段对 Codex 交付的修正

| # | 文件 | 问题 | 修正 |
| --- | --- | --- | --- |
| 1 | `BaBridge.kt` | 单线程 `ExecutorService`：一次 25s 网络超时会把 store 读写全部堵住（实测 store 回复迟迟不到） | 改为 `newFixedThreadPool(4)` |
| 2 | `BaBridge.kt` | UA 在自定义 headers **之后**设置，与 iOS（先 UA 后被 headers 覆盖）相反 | 调整顺序，与 `WebShell.swift` 一致 |
| 3 | `InsetsController.kt` | 启动瞬间注入 `--safe-t/--safe-b` 时 `document.documentElement` 尚为 null，控制台 `Uncaught TypeError` | JS 内加 `if(!r) return` 守卫 |
| 4 | `MainActivity.kt` | `target="_blank" rel="noreferrer"` 链接在 `setSupportMultipleWindows(false)` 下被 WebView 静默丢弃（资料页来源链接、更新弹窗「立即更新」都受影响） | 开启多窗口并实现 `WebChromeClient.onCreateWindow`：用一次性 WebView 捕获弹窗 URL → `ACTION_VIEW` 交系统浏览器 → 销毁 |
| 5 | `AssetServer.kt` / `BridgeShim.kt` | **列表页手指划不动**：`web/styles.css` 的 `html, body { overflow-x: hidden }` 让 Chromium 把根元素当成内容高度的滚动容器（`overflow-y` 计算为 `auto`），视口无法触摸滚动——但 `window.scrollTo`/详情页内滚仍正常，所以极易漏测 | 注入 `html{overflow:visible!important}`（`BridgeShim.LAYOUT_CSS`），保留 body 的横向裁剪；实测上滑 `y 0→630`、下滑回顶、横向 `scrollWidth==clientWidth` |

## 5. 已知问题与限制

1. **更新弹窗指向 iOS Release 页**：`web/update.js` 用 `releases/latest` 的 `html_url`，Android 用户会被带到同时含 IPA 的发布页。发 Android 版时应在 Release 里附 APK，并把更新说明改成双端措辞（属 web 侧内容，不改代码路径）。
2. **左缘 30px 右滑**：系统手势导航下该区域由系统接管；实测系统返回键已能关闭详情/浮层，UX 等价。`setSystemGestureExclusionRects` 受单边 200dp 上限，仅底部一段可能生效（已在代码中限高，未强依赖）。
3. **`--safe-b` 在本模拟器为 0**：LDPlayer 不显示三键导航栏，属设备差异；三键导航真机需复验（代码按 `systemBars()` 计算，逻辑正确）。
4. **同步依赖 gamekee（网络不稳定）**：已实测一次成功同步并落盘 1.6MB overlay、重启后角标生效；但随后同一网络下 `www.gamekee.com` 又不可达（`status=0`），「更多」页显示「检查失败」。属网络可达性问题，非实现缺陷；换稳定网络可复验。
5. **debug 签名**：可安装测试，不适合上架或长期分发；release 构建目前未签名（`assembleRelease` 产物需自行签名）。
6. **弹窗 WebView 边界**：`onCreateWindow` 的一次性 WebView 若遇到 `about:blank + document.write` 型弹窗，可能拿不到 URL（本 App 不产生此类弹窗）。
7. 未做 Adaptive Icon、启动画面定制、横屏/平板适配（与 iOS 一致锁竖屏）。

## 6. 后续建议

- 增加 GitHub Actions：`gradle assembleRelease` + 签名密钥走 Secrets，Release 附 `StudentDex-<ver>.apk`。
- 真机复验三键导航安全区、手势返回、深色模式切换。
- 若要长期分发，配置 release keystore 并把 `versionCode` 与 iOS 版本号联动。
