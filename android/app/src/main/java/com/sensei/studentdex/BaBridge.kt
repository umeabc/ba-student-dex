package com.sensei.studentdex

import android.content.Context
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors

class BaBridge(context: Context, webView: WebView) {
    private val view = WeakReference(webView)
    // A blocking 25s fetch must not stall store load/save, so keep a small pool.
    private val io = Executors.newFixedThreadPool(4)
    private val file = AtomicFile(File(context.filesDir, "ba-sync-store.json"))
    @Volatile private var closed = false

    @JavascriptInterface fun rpc(json: String) {
        io.execute {
            var id: String? = null
            try {
                val message = JSONObject(json)
                id = message.opt("id") as? String ?: return@execute
                if (message.optString("op", "fetch") == "store") {
                    handleStore(id, message.opt("action") as? String, message.opt("value") as? String)
                } else {
                    fetch(id, message)
                }
            } catch (_: Exception) {
                id?.let { reply(it, 0) }
            }
        }
    }

    @JavascriptInterface fun store(id: String?, action: String?, value: String?) {
        io.execute { if (id != null) handleStore(id, action, value) }
    }

    private fun handleStore(id: String, action: String?, value: String?) {
        if ((action ?: "load") == "save") {
            var stream: java.io.FileOutputStream? = null
            try {
                stream = file.startWrite()
                stream.write((value ?: "").toByteArray(Charsets.UTF_8))
                file.finishWrite(stream)
                reply(id, 200)
            } catch (_: Exception) {
                file.failWrite(stream)
                reply(id, 500)
            }
        } else {
            val bytes = try { file.openRead().use { it.readBytes() } } catch (_: Exception) { byteArrayOf() }
            reply(id, 200, bytes)
        }
    }

    private fun fetch(id: String, message: JSONObject) {
        var connection: HttpURLConnection? = null
        try {
            val url = URL(message.getString("url"))
            if (url.protocol.lowercase(Locale.ROOT) != "https" ||
                url.host.lowercase(Locale.ROOT) !in ALLOWED_HOSTS) {
                reply(id, 0)
                return
            }
            connection = url.openConnection() as HttpURLConnection
            connection.connectTimeout = 25_000
            connection.readTimeout = 25_000
            // Same order as WebShell.swift: fixed UA first, then caller headers may override it.
            connection.setRequestProperty("User-Agent", UA)
            message.optJSONObject("headers")?.let { headers ->
                headers.keys().forEach { key ->
                    (headers.opt(key) as? String)?.let { connection.setRequestProperty(key, it) }
                }
            }
            val status = connection.responseCode
            val stream = if (status in 200..399) connection.inputStream else connection.errorStream
            val bytes = stream?.use { it.readBytes() } ?: byteArrayOf()
            reply(id, status, bytes)
        } catch (_: Exception) {
            reply(id, 0)
        } finally {
            connection?.disconnect()
        }
    }

    private fun reply(id: String, status: Int, bytes: ByteArray = byteArrayOf()) {
        if (closed) return
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val js = "window.__baRPC && window.__baRPC('${BridgeShim.jsStringLiteral(id)}',$status,'$b64');"
        view.get()?.post {
            if (!closed) view.get()?.evaluateJavascript(js, null)
        }
    }

    fun close() {
        closed = true
        view.clear()
        io.shutdown()
    }

    companion object {
        private val ALLOWED_HOSTS = setOf("www.gamekee.com", "api-cdn.gamekee.com", "cdnimg-v2.gamekee.com", "api.github.com")
        private const val UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    }
}
