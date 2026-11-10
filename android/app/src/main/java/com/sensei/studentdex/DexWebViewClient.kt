package com.sensei.studentdex

import android.app.Activity
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

class DexWebViewClient(
    private val activity: Activity,
    private val assets: AssetServer,
    private val insets: InsetsController,
    private val external: (Uri) -> Unit,
    private val recover: (WebView) -> Unit
) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
        assets.intercept(request)

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
            (uri.port == -1 || uri.port == 443)) return false
        if (uri.scheme == "https" || uri.scheme == "http") external(uri)
        // Never navigate the bridge-bearing WebView to an untrusted document.
        return true
    }

    override fun onPageFinished(view: WebView, url: String) { insets.refresh() }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        recover(view)
        return true
    }
}
