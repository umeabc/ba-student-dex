package com.sensei.studentdex

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var bridge: BaBridge
    private lateinit var insets: InsetsController
    private lateinit var assets: AssetServer
    private var backPending = false
    private var webViewActive = false
    private val updateExecutor = Executors.newSingleThreadExecutor()
    private val updateDownloading = AtomicBoolean(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        assets = AssetServer(applicationContext)
        createWebView()
        onBackPressedDispatcher.addCallback(this) { handleBack() }
    }

    private fun createWebView() {
        if (isFinishing || isDestroyed || webViewActive) return
        webView = WebView(this)
        webViewActive = true
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = false
            // target=_blank / window.open must be captured so we can hand it to the browser.
            setSupportMultipleWindows(true)
        }
        // APK links arrive as downloads, not navigations, so shouldOverrideUrlLoading
        // never sees them. Route *.apk downloads to the updater (installer launch).
        webView.setDownloadListener { url, _, _, mimetype, _ ->
            if (url.endsWith(".apk", ignoreCase = true) ||
                mimetype == "application/vnd.android.package-archive"
            ) downloadUpdate(url)
        }
        webView.setBackgroundColor(Color.TRANSPARENT)
        webView.isVerticalScrollBarEnabled = false
        webView.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message
            ): Boolean {
                // The popup URL is only known once Chromium commits the navigation in the
                // transport WebView, so give it a throwaway WebView and intercept there.
                val probe = WebView(view.context)
                probe.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        openExternal(request.url)
                        v.destroy()
                        return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = probe
                resultMsg.sendToTarget()
                return true
            }
        }
        bridge = BaBridge(applicationContext, webView, assets.remote)
        webView.addJavascriptInterface(bridge, "__baNative")
        insets = InsetsController(this, webView)
        webView.webViewClient = DexWebViewClient(this, assets, insets, ::openExternal) { dead ->
            bridge.close()
            webViewActive = false
            (dead.parent as? ViewGroup)?.removeView(dead)
            dead.destroy()
            backPending = false
            if (!isFinishing && !isDestroyed) createWebView()
        }
        setContentView(webView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        insets.refresh()
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

    private fun handleBack() {
        if (isFinishing || isDestroyed || backPending) return
        if (!webViewActive) { finish(); return }
        val current = webView
        backPending = true
        try {
            current.evaluateJavascript(BACK_SCRIPT) { result ->
                backPending = false
                if (isFinishing || isDestroyed || current !== webView) return@evaluateJavascript
                when (result?.removeSurrounding("\"")) {
                    "root" -> finish()
                    "modal", "sheet", "detail" -> Unit
                    else -> fallbackBack(current)
                }
            }
        } catch (_: Exception) {
            backPending = false
            if (!isFinishing && !isDestroyed && current === webView) fallbackBack(current)
        }
    }

    internal fun openExternal(uri: Uri) {
        if (uri.toString().endsWith(".apk", ignoreCase = true)) {
            downloadUpdate(uri.toString())
            return
        }
        try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: ActivityNotFoundException) { }
    }

    private fun downloadUpdate(url: String) {
        if (!updateDownloading.compareAndSet(false, true)) return
        Toast.makeText(this, "开始下载更新…", Toast.LENGTH_SHORT).show()
        updateExecutor.execute {
            try {
                val dir = File(cacheDir, "update").apply { mkdirs() }
                val apk = File(dir, "StudentDex-update.apk")
                downloadApk(url, apk)
                runOnUiThread { installUpdate(apk) }
            } catch (e: Exception) {
                runOnUiThread {
                    updateDownloading.set(false)
                    Toast.makeText(this, "更新下载失败：${e.message ?: "未知错误"}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun downloadApk(source: String, target: File) {
        var url = URL(source)
        var redirects = 0
        while (true) {
            val connection = url.openConnection() as HttpURLConnection
            connection.connectTimeout = 30_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = true
            try {
                val code = connection.responseCode
                if (code in 300..399) {
                    val location = connection.getHeaderField("Location") ?: throw java.io.IOException("重定向失败")
                    url = URL(url, location)
                    if (++redirects > 8) throw java.io.IOException("重定向过多")
                    continue
                }
                if (code != HttpURLConnection.HTTP_OK) throw java.io.IOException("HTTP $code")
                connection.inputStream.use { input ->
                    FileOutputStream(target).use { output -> input.copyTo(output) }
                }
                return
            } finally {
                connection.disconnect()
            }
        }
    }

    private fun installUpdate(apk: File) {
        try {
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", apk)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(intent)
        } catch (e: Exception) {
            Toast.makeText(this, "无法安装更新：${e.message ?: "未知错误"}", Toast.LENGTH_LONG).show()
        } finally {
            updateDownloading.set(false)
        }
    }

    private fun fallbackBack(view: WebView) {
        if (view.canGoBack()) view.goBack() else finish()
    }

    override fun onPause() { if (webViewActive) webView.onPause(); super.onPause() }
    override fun onResume() { super.onResume(); if (webViewActive) webView.onResume() }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        setTheme(R.style.AppTheme)
        if (webViewActive) insets.refresh()
    }

    override fun onDestroy() {
        updateExecutor.shutdownNow()
        if (webViewActive) {
            bridge.close()
            webView.removeJavascriptInterface("__baNative")
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
            webViewActive = false
        }
        super.onDestroy()
    }

    companion object {
        private const val BACK_SCRIPT = """(function(){
var m=document.getElementById('update-modal');
if(m){var b=m.querySelector('[data-act="modal-close"]'); if(b){b.click(); return 'modal';}}
var s=document.getElementById('sheet');
if(s && !s.hidden){var f=s.querySelector('[data-act="filter-close"]'); if(f){f.click(); return 'sheet';}}
var d=document.getElementById('detail');
if(d && d.classList.contains('in')){var k=d.querySelector('[data-act="back"]'); if(k){k.click(); return 'detail';}}
return 'root';
})()"""
    }
}
