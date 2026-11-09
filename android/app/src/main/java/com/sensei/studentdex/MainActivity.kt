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
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var bridge: BaBridge
    private lateinit var insets: InsetsController
    private lateinit var assets: AssetServer
    private var backPending = false

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
        if (isFinishing || isDestroyed) return
        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = false
            // target=_blank / window.open must be captured so we can hand it to the browser.
            setSupportMultipleWindows(true)
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
        bridge = BaBridge(applicationContext, webView)
        webView.addJavascriptInterface(bridge, "__baNative")
        insets = InsetsController(this, webView)
        webView.webViewClient = DexWebViewClient(this, assets, insets) { dead ->
            bridge.close()
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

    private fun openExternal(uri: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: ActivityNotFoundException) { }
    }

    private fun fallbackBack(view: WebView) {
        if (view.canGoBack()) view.goBack() else finish()
    }

    override fun onPause() { webView.onPause(); super.onPause() }
    override fun onResume() { super.onResume(); if (::webView.isInitialized) webView.onResume() }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        setTheme(R.style.AppTheme)
        insets.refresh()
    }

    override fun onDestroy() {
        bridge.close()
        webView.removeJavascriptInterface("__baNative")
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
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
