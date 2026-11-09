package com.sensei.studentdex

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream

class AssetServer(private val context: Context) {
    private val loader = WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build()
    @Volatile private var cachedBytes: ByteArray? = null

    private fun indexBytes(): ByteArray = cachedBytes ?: synchronized(this) {
        cachedBytes ?: run {
            val html = try {
                context.assets.open("index.html").bufferedReader(Charsets.UTF_8).use { it.readText() }
                    .replaceFirst(
                        "<head>",
                        "<head><style>" + BridgeShim.LAYOUT_CSS + "</style>" +
                            "<script>${BridgeShim.SCRIPT}</script>"
                    )
            } catch (_: Exception) {
                "<html><body><h3>Missing resources</h3><p>Cannot read assets/index.html</p></body></html>"
            }
            html.toByteArray(Charsets.UTF_8).also { cachedBytes = it }
        }
    }

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
            (uri.path == "/assets/index.html" || uri.path == "/assets/")) {
            return WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(indexBytes()))
        }
        return loader.shouldInterceptRequest(uri)
    }
}
