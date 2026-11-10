package com.sensei.studentdex

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.net.URLDecoder
import java.util.Locale

class AssetServer(private val context: Context) {
    internal val remote = RemoteAssets(context)
    private val loader = WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", ResourcePathHandler()).build()
    @Volatile private var cachedBytes: ByteArray? = null

    private inner class ResourcePathHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse {
            val decoded = try { URLDecoder.decode(path, "UTF-8") } catch (_: Exception) { return notFound() }
            if (decoded.isEmpty() || decoded.startsWith('/') || decoded.split('/').any { it == ".." }) return notFound()

            remote.cached(decoded)?.let { file ->
                return response(mimeFromContent(file) ?: mimeType(decoded), FileInputStream(file))
            }
            remote.load(decoded)?.let { bytes ->
                return response(sniffMime(bytes) ?: mimeType(decoded), ByteArrayInputStream(bytes))
            }
            return try {
                response(mimeType(decoded), context.assets.open(decoded))
            } catch (_: Exception) {
                notFound()
            }
        }
    }

    private fun response(mime: String, stream: java.io.InputStream): WebResourceResponse {
        val text = mime.startsWith("text/") || mime == "application/javascript" || mime == "application/json"
        return WebResourceResponse(mime, if (text) "utf-8" else null, stream)
    }

    private fun notFound(): WebResourceResponse = WebResourceResponse(
        "text/plain", "utf-8", ByteArrayInputStream(ByteArray(0))
    ).apply { setStatusCodeAndReasonPhrase(404, "Not Found") }

    private fun mimeFromContent(file: File): String? = try {
        val header = ByteArray(12)
        val count = FileInputStream(file).use { it.read(header) }
        sniffMime(if (count > 0) header.copyOf(count) else byteArrayOf())
    } catch (_: Exception) {
        null
    }

    private fun sniffMime(bytes: ByteArray): String? = when {
        bytes.size >= 4 && bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte() &&
            bytes[2] == 0x4e.toByte() && bytes[3] == 0x47.toByte() -> "image/png"
        bytes.size >= 2 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() -> "image/jpeg"
        bytes.size >= 12 && bytes.copyOfRange(0, 4).toString(Charsets.US_ASCII) == "RIFF" &&
            bytes.copyOfRange(8, 12).toString(Charsets.US_ASCII) == "WEBP" -> "image/webp"
        else -> null
    }

    private fun mimeType(path: String): String = when (File(path).extension.lowercase(Locale.ROOT)) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "svg" -> "image/svg+xml"
        "js" -> "application/javascript"
        "css" -> "text/css"
        "html", "htm" -> "text/html"
        "json" -> "application/json"
        "mp4" -> "video/mp4"
        "mp3" -> "audio/mpeg"
        "m4a" -> "audio/mp4"
        "ogg" -> "audio/ogg"
        "wav" -> "audio/wav"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        else -> "application/octet-stream"
    }

    private fun indexBytes(): ByteArray = cachedBytes ?: synchronized(this) {
        cachedBytes ?: run {
            val html = try {
                context.assets.open("index.html").bufferedReader(Charsets.UTF_8).use { it.readText() }
                    .replaceFirst(
                        "<head>",
                        "<head><style>" + BridgeShim.LAYOUT_CSS + "</style>" +
                            "<script>${BridgeShim.SCRIPT}${BridgeShim.LAZY_IMAGES}</script>"
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
