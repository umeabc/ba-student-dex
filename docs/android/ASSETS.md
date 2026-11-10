# Android 图片按需回源与缓存

## 架构

APK 仅打包页面、数据、脚本、字体和 `asset-map.json`，不包含 `avatars/`、`img/`、`portraits/`。WebView 请求本地 `appassets.androidplatform.net` URL 时，`AssetServer` 依次处理：

1. `index.html` 从 APK 读取并注入原生桥、布局修复和图片懒加载脚本。
2. 其他路径先查 `filesDir/ba-assets/<SHA-1(本地路径)>`，命中后直接流式返回。
3. 缓存未命中且映射存在时，在 WebView 的后台回调线程从 GameKee 获取原图，处理后原子写缓存并返回。
4. 映射没有的路径回退到 APK assets；仍不存在则返回 404。

映射在独立后台线程启动时读取，不阻塞 UI；图片回源和批量路径枚举最多等待映射就绪 3 秒，超时按本次 404/失败处理，映射加载完成后后续请求仍可正常回源。回源使用固定 iPhone Safari User-Agent 与 GameKee Referer，连接和读取超时均为 25 秒，仅允许 HTTPS 及映射中的 host（默认包含 `cdnimg-v2.gamekee.com`）。同时回源最多 20 个连接，同一路径通过 latch 去重。若连续 5 次回源失败，永久保留 12 个信号量许可，把后续并发自动降为 8；当前请求继续完成，整批任务不中断，成功后也不会在本进程内升回 20。

## 映射生成

在仓库根目录运行：

```sh
python android/tools/build_asset_map.py
```

脚本只使用 Python 标准库，合并以下来源并输出紧凑、排序、确定性的 `android/app/src/main/assets/asset-map.json`：

- `data/build/students/<id>.json` 的 `avatarRemote` → `avatars/<id>.jpg`
- `data/build/imgmap.json` 的 URL/hash 反向映射 → `img/<hash>.png`
- `data/build/portraitmap.json` 的 URL/hash 反向映射 → `portraits/<hash>.jpg`

脚本要求映射集合与 `web/` 三类文件集合完全一致；当前为 **3877 条，465046 字节**。缺失、额外或非法 URL 会以非零状态退出并打印差异。产物应提交到 git，正常 APK 构建不需要 Python。

新数据同步或重新抓取后，先确认三类 `web/` 文件及 `data/build/` 映射均已更新，再重跑上述命令、检查条目数与 git diff，然后重新构建 APK。不要修改 CDN URL 中的 `w_..` / `h_..` 参数。

## 降采样与 MIME

- `avatars/`：先用 bounds 计算 `inSampleSize`，再解码；宽度大于 360 px 时等比缩至 360 px，保留 alpha，API 30+ 编码为 lossy WebP，较早版本使用兼容 WebP，quality 80。
- `portraits/`：同样先采样，最大宽度 480 px；先合成 `rgb(26,34,48) → rgb(36,46,64)` 竖直渐变背景，再编码为 JPEG quality 82，避免透明区域出现黑底。
- `img/`：原样缓存，避免小图标重复编码。

解码或压缩失败时保留原始字节，不让图片请求因处理异常崩溃。返回和读取缓存时优先嗅探 PNG、JPEG、WebP 文件头，无法识别才按扩展名判断 MIME，因此源头像实际为 PNG 或处理降级时仍能正确显示。

## 两档离线下载

Android 的「更多 → 离线资源」提供两档预取：

- **头像与图标（`basic`，默认）**：`avatars/` + `img/`，共 **3366 张**；实测抽样估算约 **175MB 源站流量 / 135MB 缓存**。
- **全部图片（`all`）**：以上资源加 `portraits/`，共 **3877 张**；实测抽样估算约 **500MB 源站流量 / 165MB 缓存**，建议 Wi-Fi。按钮第一次点击只进入「再点一次确认 500MB」状态，须在 5 秒内再次点击才开始，超时自动恢复。

实际大小随 CDN 源图与失败降级而变化。两档共用同一个后台任务，运行中对应行显示进度并提供取消，另一行按钮禁用。`start` 仅接受 `basic` / `all`，状态中的 `scope` 标识当前或最近任务范围。

开始前检查内部存储可用空间必须大于 300MB。任务使用 12 个 worker，已有缓存直接跳过并计入进度，因此取消或失败后的再次开始相当于续传；单张失败只累计失败数，不中断整批任务。取消后不开始新下载，正在进行的请求会完成，界面继续显示当前已缓存数量。

「状态」每 800ms 更新已处理张数、失败数和缓存字节数，离开「更多」页停止轮询但不取消后台下载。完成后刷新既有「素材缓存」统计；再次下载会跳过已成功文件并仅重试缺失/失败文件。全部缓存位于应用私有 `filesDir/ba-assets/`，文件名不带扩展名，目录内 `.nomedia` 防止媒体库索引且不计入离线资源字节数。

## 缓存统计与清理

图片缓存位于应用内部存储私有目录 `filesDir/ba-assets/`，文件名为本地路径的 SHA-1（不带图片扩展名）；先写同目录临时文件再 `renameTo`，失败会清理临时文件。影画/语音桥缓存仍位于内部存储 `filesDir/ba-media/`，使用 FNV-1a 64 位哈希文件名。两个目录都会创建空 `.nomedia` 文件，不参与相册/媒体库索引，清理缓存后会补建该标记。

「更多 → 存储」的 `cache size` 统计两个目录的总字节数，`cache clear` 清空两个目录。清理不会主动重建当前已显示图片；后续请求会重新回源，这是预期行为。源图没有 CDN 协商压缩，首次流量会明显高于落盘缓存。

## 失败降级与数据量

网络错误、非 200 响应、重定向过多或 host 不允许时记录 `DexAssets` warning，并返回空 404；成功请求不逐张打日志。核心 JS/CSS/HTML 不受影响。首次打开学生网格建议 Wi-Fi，源头像单张约 200 KB 级。

当前实测预估为：仅头像与图标约 **175MB 源流量 / 135MB 缓存**（实测），三类全量约 **500MB 源流量 / 165MB 缓存**。实际值取决于访问范围、CDN 响应和 JPEG 内容。`img/` 原样保留，解码失败的头像/立绘也会以原始大小缓存。
