package com.sensei.studentdex

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Lazily fetches original GameKee images and stores smaller, private copies. */
class RemoteAssets(context: Context) {
    private val appContext = context.applicationContext
    private val cacheDir = File(appContext.filesDir, CACHE_DIR)
    @Volatile private var sources: Map<String, String> = emptyMap()
    @Volatile private var allowedHosts: Set<String> = setOf(DEFAULT_HOST)
    private val connections = Semaphore(20)
    private val consecutiveFailures = AtomicInteger(0)
    private val degraded = AtomicBoolean(false)
    private val inFlight = ConcurrentHashMap<String, CountDownLatch>()
    private val ready = CountDownLatch(1)

    init {
        Thread({
            try {
                val json = appContext.assets.open("asset-map.json").bufferedReader(Charsets.UTF_8).use { it.readText() }
                val objectJson = JSONObject(json)
                val result = HashMap<String, String>(objectJson.length())
                val hosts = HashSet<String>().apply { add(DEFAULT_HOST) }
                objectJson.keys().forEach { key ->
                    val url = objectJson.getString(key)
                    result[key] = url
                    URL(url).host?.lowercase()?.takeIf { it.isNotEmpty() }?.let(hosts::add)
                }
                allowedHosts = hosts
                sources = result
            } catch (_: Exception) {
                // Until a valid map is available, AssetServer follows its normal 404 fallback.
            } finally {
                ready.countDown()
            }
        }, "dex-asset-map").start()
    }

    fun cached(path: String): File? {
        val file = File(cacheDir, sha1(path))
        if (!file.isFile) return null
        try {
            val noMedia = File(cacheDir, ".nomedia")
            if (!noMedia.isFile) noMedia.writeBytes(byteArrayOf())
        } catch (_: Exception) { }
        return file
    }

    private fun awaitReady(): Boolean = try {
        ready.await(3, TimeUnit.SECONDS)
    } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        false
    }

    fun paths(scope: String): List<String> {
        if (!awaitReady()) return emptyList()
        return sources.keys.filter { path ->
            scope == "all" || path.startsWith("avatars/") || path.startsWith("img/")
        }.sorted()
    }

    private fun recordFetchResult(success: Boolean) {
        if (success) {
            consecutiveFailures.set(0)
            return
        }
        if (consecutiveFailures.incrementAndGet() < 5 || !degraded.compareAndSet(false, true)) return
        // Permanently reserve 12 of the 20 permits; in-flight requests finish normally.
        connections.acquireUninterruptibly(12)
        Log.w(TAG, "5 consecutive failures; concurrency reduced to 8")
    }

    fun cacheBytes(): Long = try {
        cacheDir.walkBottomUp().sumOf { file ->
            if (file.isFile && file.name != ".nomedia") file.length() else 0L
        }
    } catch (_: Exception) {
        0L
    }

    fun ensureCached(path: String): Boolean = cached(path) != null || load(path) != null

    fun load(path: String): ByteArray? {
        if (!awaitReady()) return null
        val url = sources[path] ?: return null
        val existing = CountDownLatch(1)
        val latch = inFlight.putIfAbsent(path, existing)
        if (latch != null) {
            return try {
                latch.await()
                cached(path)?.readBytes()
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                null
            } catch (_: Exception) {
                null
            }
        }
        try {
            connections.acquire()
            val raw = try { fetch(path, url) } finally { connections.release() }
            recordFetchResult(raw != null)
            if (raw == null) return null
            val processed = process(path, raw)
            if (!writeAtomically(cachedFile(path), processed)) return null
            return processed
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            return null
        } catch (_: Exception) {
            Log.w(TAG, "$path 0")
            return null
        } finally {
            inFlight.remove(path, existing)
            existing.countDown()
        }
    }

    private fun fetch(path: String, source: String): ByteArray? {
        var url = URL(source)
        var redirects = 0
        while (true) {
            if (url.protocol.lowercase() != "https" || url.host.lowercase() !in allowedHosts) {
                Log.w(TAG, "$path 403")
                return null
            }
            val connection = url.openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 25_000
                connection.readTimeout = 25_000
                // Validate every redirect target instead of auto-following to an arbitrary host.
                connection.instanceFollowRedirects = false
                connection.setRequestProperty("User-Agent", USER_AGENT)
                connection.setRequestProperty("Referer", REFERER)
                val code = connection.responseCode
                if (code in 300..399) {
                    val location = connection.getHeaderField("Location")
                    if (location == null || ++redirects > 8) {
                        Log.w(TAG, "$path $code")
                        return null
                    }
                    url = URL(url, location)
                    continue
                }
                if (code != HttpURLConnection.HTTP_OK) {
                    Log.w(TAG, "$path $code")
                    return null
                }
                return connection.inputStream.use { it.readBytes() }
            } catch (_: Exception) {
                Log.w(TAG, "$path 0")
                return null
            } finally {
                connection.disconnect()
            }
        }
    }

    private fun process(path: String, raw: ByteArray): ByteArray {
        val maxWidth = when {
            path.startsWith("avatars/") -> 360
            path.startsWith("portraits/") -> 480
            else -> return raw
        }
        var bitmap: Bitmap? = null
        var scaled: Bitmap? = null
        try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return raw
            val options = BitmapFactory.Options().apply {
                inSampleSize = 1
                while (bounds.outWidth / inSampleSize > maxWidth * 2) inSampleSize *= 2
            }
            bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.size, options) ?: return raw
            val source = bitmap!!
            scaled = if (source.width > maxWidth) {
                val height = (source.height.toLong() * maxWidth / source.width).toInt().coerceAtLeast(1)
                Bitmap.createScaledBitmap(source, maxWidth, height, true)
            } else source
            val output = ByteArrayOutputStream()
            if (path.startsWith("avatars/")) {
                @Suppress("DEPRECATION")
                val format = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    Bitmap.CompressFormat.WEBP_LOSSY
                } else Bitmap.CompressFormat.WEBP
                if (!scaled!!.compress(format, 80, output)) return raw
            } else {
                val source = scaled!!
                val flat = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
                try {
                    val canvas = Canvas(flat)
                    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        shader = LinearGradient(
                            0f, 0f, 0f, source.height.toFloat(),
                            Color.rgb(26, 34, 48), Color.rgb(36, 46, 64), Shader.TileMode.CLAMP
                        )
                    }
                    canvas.drawRect(0f, 0f, source.width.toFloat(), source.height.toFloat(), paint)
                    canvas.drawBitmap(source, 0f, 0f, null)
                    if (!flat.compress(Bitmap.CompressFormat.JPEG, 82, output)) return raw
                } finally {
                    flat.recycle()
                }
            }
            return output.toByteArray()
        } catch (_: Exception) {
            return raw
        } catch (_: OutOfMemoryError) {
            return raw
        } finally {
            if (scaled != null && scaled !== bitmap) scaled.recycle()
            bitmap?.recycle()
        }
    }

    private fun cachedFile(path: String) = File(cacheDir, sha1(path))

    private fun writeAtomically(target: File, bytes: ByteArray): Boolean {
        val temp = File(cacheDir, target.name + "." + Thread.currentThread().id + ".tmp")
        try {
            if (!cacheDir.isDirectory && !cacheDir.mkdirs()) throw IOException("mkdir failed")
            val noMedia = File(cacheDir, ".nomedia")
            if (!noMedia.isFile) noMedia.writeBytes(byteArrayOf())
            FileOutputStream(temp).use { it.write(bytes) }
            if (temp.renameTo(target)) return true
            if (target.isFile) return true
            throw IOException("rename failed")
        } catch (_: Exception) {
            return false
        } finally {
            if (temp.exists()) temp.delete()
        }
    }

    private fun sha1(value: String): String = MessageDigest.getInstance("SHA-1")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    companion object {
        const val CACHE_DIR = "ba-assets"
        private const val TAG = "DexAssets"
        private const val DEFAULT_HOST = "cdnimg-v2.gamekee.com"
        private const val REFERER = "https://www.gamekee.com/"
        private const val USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    }
}
