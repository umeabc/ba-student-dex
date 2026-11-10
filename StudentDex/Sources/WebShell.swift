import SwiftUI
import UIKit
import WebKit

/// WKWebView subclass that mirrors the native safe-area insets into CSS custom
/// properties so the layout can hug the notch / home indicator.
final class ShellWebView: WKWebView {
    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        let top = safeAreaInsets.top
        let bottom = safeAreaInsets.bottom
        let js = "document.documentElement.style.setProperty('--safe-t','\(top)px');" +
                 "document.documentElement.style.setProperty('--safe-b','\(bottom)px');"
        evaluateJavaScript(js, completionHandler: nil)
    }
}

/// Tiny RPC bridge used by web/sync.js.
///
/// The page is loaded from `file://`, therefore it cannot talk to gamekee:
/// the API needs a custom `game-alias` header (CORS preflight would fail) and
/// the image CDN checks `Referer`, which a browser cannot forge. So every HTTP
/// call is performed here with URLSession and the result is handed back to JS.
///
/// Protocol (JS -> native):
///   { id, op: "fetch", url, headers }
///   { id, op: "store", action: "load" | "save", key, value }
/// Native -> JS:
///   window.__baRPC(id, status, base64Body)
final class BridgeHandler: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    private static let allowedHosts: Set<String> = [
        "www.gamekee.com",
        "api-cdn.gamekee.com",
        "cdnimg-v2.gamekee.com",
        "api.github.com"
    ]

    private static let userAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    private var storeURL: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("ba-sync-store.json")
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "ba",
              let body = message.body as? [String: Any],
              let id = body["id"] as? String else { return }

        let op = (body["op"] as? String) ?? "fetch"
        if op == "store" {
            handleStore(id: id, body: body)
            return
        }
        if op == "cache" {
            handleCache(id: id, body: body)
            return
        }

        guard let urlString = body["url"] as? String,
              let url = URL(string: urlString),
              let host = url.host?.lowercased(),
              url.scheme?.lowercased() == "https",
              BridgeHandler.allowedHosts.contains(host) else {
            reply(id: id, status: 0, data: nil)
            return
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 25
        request.setValue(BridgeHandler.userAgent, forHTTPHeaderField: "User-Agent")
        if let headers = body["headers"] as? [String: String] {
            for (key, value) in headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }

        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            self?.reply(id: id, status: status, data: data)
        }.resume()
    }

    // MARK: - local key/value store (sync overlay)

    private func handleStore(id: String, body: [String: Any]) {
        let action = (body["action"] as? String) ?? "load"
        if action == "save" {
            let value = (body["value"] as? String) ?? ""
            do {
                try value.data(using: .utf8)?.write(to: storeURL, options: .atomic)
                reply(id: id, status: 200, data: Data())
            } catch {
                reply(id: id, status: 500, data: nil)
            }
            return
        }
        let data = (try? Data(contentsOf: storeURL)) ?? Data()
        reply(id: id, status: 200, data: data)
    }

    // MARK: - 素材缓存（影画 / 语音的二进制文件，按 url 的 sha256 存盘）

    private var cacheDir: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("ba-media", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: nil)
        }
        return dir
    }

    /// 稳定文件名（不能用 Swift 的 hashValue，它每个进程都会变）
    private func cacheName(for key: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in key.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return String(format: "%016llx", hash)
    }

    private func handleCache(id: String, body: [String: Any]) {
        let action = (body["action"] as? String) ?? "get"
        let dir = cacheDir

        switch action {
        case "set":
            guard let key = body["key"] as? String,
                  let b64 = body["data"] as? String,
                  let data = Data(base64Encoded: b64) else {
                reply(id: id, status: 400, data: nil)
                return
            }
            let file = dir.appendingPathComponent(cacheName(for: key))
            do {
                try data.write(to: file, options: .atomic)
                reply(id: id, status: 200, data: Data())
            } catch {
                reply(id: id, status: 500, data: nil)
            }

        case "get":
            guard let key = body["key"] as? String else {
                reply(id: id, status: 400, data: nil)
                return
            }
            let file = dir.appendingPathComponent(cacheName(for: key))
            if let data = try? Data(contentsOf: file) {
                reply(id: id, status: 200, data: data)
            } else {
                reply(id: id, status: 404, data: nil)
            }

        case "size":
            var total: Int64 = 0
            if let files = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: [.fileSizeKey]) {
                for f in files {
                    total += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
                }
            }
            reply(id: id, status: 200, data: Data(String(total).utf8))

        case "clear":
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            for f in files { try? FileManager.default.removeItem(at: f) }
            reply(id: id, status: 200, data: Data())

        default:
            reply(id: id, status: 400, data: nil)
        }
    }

    // MARK: - reply

    private func reply(id: String, status: Int, data: Data?) {
        let b64 = data?.base64EncodedString() ?? ""
        let js = "window.__baRPC && window.__baRPC('\(id)', \(status), '\(b64)');"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}

struct WebShell: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ShellWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        configuration.defaultWebpagePreferences = preferences

        // JS RPC bridge (see BridgeHandler above)
        let bridge = BridgeHandler()
        context.coordinator.bridge = bridge
        configuration.userContentController.add(bridge, name: "ba")

        let webView = ShellWebView(frame: .zero, configuration: configuration)
        bridge.webView = webView
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.933, green: 0.953, blue: 0.980, alpha: 1.0)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.allowsBackForwardNavigationGestures = false

        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Web") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            let html = "<html><body style='font-family:-apple-system;padding:40px;text-align:center;color:#666'>" +
                       "<h3>资源缺失</h3><p>未找到 Web/index.html</p></body></html>"
            webView.loadHTMLString(html, baseURL: nil)
        }
        return webView
    }

    func updateUIView(_ uiView: ShellWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?
        var bridge: BridgeHandler?

        /// Keep the local bundle inside the app; open outside links in Safari.
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            if let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https" {
                if navigationAction.navigationType == .linkActivated ||
                    navigationAction.targetFrame == nil {
                    UIApplication.shared.open(url, options: [:], completionHandler: nil)
                    decisionHandler(.cancel)
                    return
                }
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url,
               let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https" {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript(
                "document.documentElement.style.setProperty('--safe-t','\(webView.safeAreaInsets.top)px');" +
                "document.documentElement.style.setProperty('--safe-b','\(webView.safeAreaInsets.bottom)px');",
                completionHandler: nil)
        }
    }
}
