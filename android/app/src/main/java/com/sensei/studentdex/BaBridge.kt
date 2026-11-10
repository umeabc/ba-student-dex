package com.sensei.studentdex

import android.content.Context
import android.os.StatFs
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
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class BaBridge(context: Context, webView: WebView, private val remote: RemoteAssets) {
    private val view = WeakReference(webView)
    // A blocking 25s fetch must not stall store load/save, so keep a small pool.
    private val io = Executors.newFixedThreadPool(4)
    private val file = AtomicFile(File(context.filesDir, "ba-sync-store.json"))
    private val cacheDir = File(context.filesDir, "ba-media")
    private val assetCacheDir = File(context.filesDir, RemoteAssets.CACHE_DIR)
    private val appFilesDir = context.filesDir
    @Volatile private var closed = false
    @Volatile private var cancelled = false
    @Volatile private var prefetchScope = "basic"
    private val prefetchLock = Any()
    private val prefetchRunning = AtomicBoolean(false)
    private val prefetchDone = AtomicInteger(0)
    private val prefetchTotal = AtomicInteger(0)
    private val prefetchFailed = AtomicInteger(0)
    private var prefetchPool: ExecutorService? = null

    @JavascriptInterface fun rpc(json: String) {
        io.execute {
            var id: String? = null
            try {
                val message = JSONObject(json)
                id = message.opt("id") as? String ?: return@execute
                when (message.optString("op", "fetch")) {
                    "store" -> handleStore(id, message.opt("action") as? String, message.opt("value") as? String)
                    "cache" -> handleCache(id, message)
                    "prefetch" -> handlePrefetch(id, message.optString("action", "status"), message)
                    else -> fetch(id, message)
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

    private fun handleCache(id: String, message: JSONObject) {
        when (message.opt("action") as? String ?: "get") {
            "set" -> {
                val key = message.opt("key") as? String
                val encoded = message.opt("data") as? String
                val bytes = try { encoded?.let { Base64.decode(it, Base64.DEFAULT) } } catch (_: IllegalArgumentException) { null }
                if (key == null || bytes == null) { reply(id, 400); return }
                val target = File(cacheDir, cacheName(key))
                val atomic = AtomicFile(target)
                var stream: java.io.FileOutputStream? = null
                try {
                    ensureCacheDir(cacheDir)
                    stream = atomic.startWrite()
                    stream.write(bytes)
                    atomic.finishWrite(stream)
                    reply(id, 200)
                } catch (_: Exception) {
                    atomic.failWrite(stream)
                    reply(id, 500)
                }
            }
            "get" -> {
                val key = message.opt("key") as? String
                if (key == null) { reply(id, 400); return }
                try { ensureCacheDir(cacheDir) } catch (_: Exception) { }
                val source = File(cacheDir, cacheName(key))
                val bytes = try { source.readBytes() } catch (_: Exception) { null }
                reply(id, if (bytes == null) 404 else 200, bytes ?: byteArrayOf())
            }
            "size" -> {
                val total = listOf(cacheDir, assetCacheDir).sumOf { dir ->
                    try { ensureCacheDir(dir) } catch (_: Exception) { }
                    dir.walkBottomUp().sumOf { if (it.isFile) it.length() else 0L }
                }
                reply(id, 200, total.toString().toByteArray(Charsets.UTF_8))
            }
            "clear" -> {
                listOf(cacheDir, assetCacheDir).forEach { dir ->
                    dir.listFiles()?.forEach { it.deleteRecursively() }
                    try { ensureCacheDir(dir) } catch (_: Exception) { }
                }
                reply(id, 200)
            }
            else -> reply(id, 400)
        }
    }

    private fun ensureCacheDir(dir: File) {
        if (!dir.isDirectory && !dir.mkdirs()) throw java.io.IOException("mkdir failed")
        val marker = File(dir, ".nomedia")
        if (!marker.isFile) marker.writeBytes(byteArrayOf())
    }

    private fun cacheName(key: String): String {
        var hash = 0xcbf29ce484222325uL.toLong()
        for (byte in key.toByteArray(Charsets.UTF_8)) {
            hash = hash xor (byte.toLong() and 0xff)
            hash *= 0x100000001b3
        }
        return "%016x".format(hash)
    }

    private fun handlePrefetch(id: String, action: String, message: JSONObject) {
        when (action) {
            "start" -> startPrefetch(id, message.optString("scope", "basic"))
            "cancel" -> {
                cancelled = true
                reply(id, 200, prefetchStatus().toString().toByteArray(Charsets.UTF_8))
            }
            "status" -> reply(id, 200, prefetchStatus().toString().toByteArray(Charsets.UTF_8))
            else -> reply(id, 400)
        }
    }

    private fun startPrefetch(id: String, scope: String) {
        if (scope != "basic" && scope != "all") { reply(id, 400); return }
        synchronized(prefetchLock) {
            if (prefetchRunning.get()) {
                reply(id, 200, prefetchStatus().toString().toByteArray(Charsets.UTF_8))
                return
            }
            if (StatFs(appFilesDir.absolutePath).availableBytes <= 300L * 1024 * 1024) {
                reply(id, 200, JSONObject().put("error", "space").toString().toByteArray(Charsets.UTF_8))
                return
            }
            val paths = remote.paths(scope)
            prefetchScope = scope
            cancelled = false
            prefetchDone.set(0)
            prefetchFailed.set(0)
            prefetchTotal.set(paths.size)
            val next = AtomicInteger(0)
            val workersDone = AtomicInteger(0)
            val pool = Executors.newFixedThreadPool(12)
            prefetchPool = pool
            prefetchRunning.set(true)
            repeat(12) {
                pool.execute {
                    try {
                        while (!cancelled && !closed) {
                            val index = next.getAndIncrement()
                            if (index >= paths.size) break
                            if (remote.ensureCached(paths[index])) prefetchDone.incrementAndGet()
                            else prefetchFailed.incrementAndGet()
                        }
                    } finally {
                        if (workersDone.incrementAndGet() == 12) {
                            prefetchRunning.set(false)
                            pool.shutdown()
                        }
                    }
                }
            }
            reply(id, 200, prefetchStatus().toString().toByteArray(Charsets.UTF_8))
        }
    }

    private fun prefetchStatus(): JSONObject = JSONObject()
        .put("running", prefetchRunning.get())
        .put("scope", prefetchScope)
        .put("done", prefetchDone.get())
        .put("total", prefetchTotal.get())
        .put("failed", prefetchFailed.get())
        .put("bytes", remote.cacheBytes())

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
        cancelled = true
        synchronized(prefetchLock) { prefetchPool?.shutdown() }
        prefetchPool = null
        view.clear()
        io.shutdown()
    }

    companion object {
        private val ALLOWED_HOSTS = setOf("www.gamekee.com", "api-cdn.gamekee.com", "cdnimg-v2.gamekee.com", "api.github.com")
        private const val UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    }
}
