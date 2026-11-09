package com.sensei.studentdex

import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.os.Build
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlin.math.roundToInt

class InsetsController(private val activity: ComponentActivity, private val webView: WebView) {
    private var top = 0
    private var bottom = 0

    init {
        ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val density = activity.resources.displayMetrics.density
            top = (sys.top / density).roundToInt()
            bottom = (sys.bottom / density).roundToInt()
            replay()
            insets
        }
        webView.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            if (Build.VERSION.SDK_INT >= 29) {
                val d = activity.resources.displayMetrics.density
                try {
                    webView.systemGestureExclusionRects = listOf(
                        Rect(0, (webView.height - (200 * d).roundToInt()).coerceAtLeast(0),
                            (32 * d).roundToInt(), webView.height))
                } catch (_: Exception) { }
            }
        }
    }

    fun refresh() {
        syncChrome()
        ViewCompat.getRootWindowInsets(webView)?.let {
            val sys = it.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val density = activity.resources.displayMetrics.density
            top = (sys.top / density).roundToInt()
            bottom = (sys.bottom / density).roundToInt()
        }
        replay()
        ViewCompat.requestApplyInsets(webView)
    }

    private fun syncChrome() {
        val night = isNight()
        WindowInsetsControllerCompat(activity.window, webView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }
        activity.window.setBackgroundDrawableResource(if (night) R.color.bg_dark else R.color.bg_light)
        if (Build.VERSION.SDK_INT >= 29) activity.window.isNavigationBarContrastEnforced = false
    }

    private fun isNight() = (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    private fun replay() {
        if (activity.isFinishing || activity.isDestroyed) return
        // documentElement is null while the very first navigation is still about:blank.
        val js = "(function(){var r=document.documentElement;if(!r)return;" +
            "r.style.setProperty('--safe-t','${top}px');" +
            "r.style.setProperty('--safe-b','${bottom}px');" +
            "var night=${isNight()};" + THEME_SCRIPT + "})();"
        webView.evaluateJavascript(js, null)
    }

    companion object {
        // Mirrors only the color variables overridden by the existing dark media query.
        private const val THEME_SCRIPT = """var d={"--bg": "#0b1220", "--bg-soft": "#0f1727", "--card": "#151f33", "--card-2": "#1b2740", "--ink": "#eef3fb", "--ink-2": "#c6d2e4", "--sub": "#8b9cb5", "--line": "rgba(255, 255, 255, 0.08)", "--line-strong": "rgba(255, 255, 255, 0.16)", "--accent": "#6a9dff", "--accent-soft": "rgba(106, 157, 255, 0.16)", "--shadow-sm": "0 2px 8px rgba(0, 0, 0, 0.4)", "--shadow": "0 10px 28px rgba(0, 0, 0, 0.45)", "--shadow-lg": "0 18px 50px rgba(0, 0, 0, 0.6)"};var l={"--bg": "#eef3fa", "--bg-soft": "#f7f9fd", "--card": "#ffffff", "--card-2": "#f4f7fc", "--ink": "#101b2d", "--ink-2": "#33445e", "--sub": "#6b7c95", "--line": "rgba(16, 27, 45, 0.08)", "--line-strong": "rgba(16, 27, 45, 0.14)", "--accent": "#3b7bfa", "--accent-soft": "rgba(59, 123, 250, 0.12)", "--shadow-sm": "0 2px 8px rgba(19, 38, 70, 0.06)", "--shadow": "0 10px 28px rgba(19, 38, 70, 0.10)", "--shadow-lg": "0 18px 50px rgba(12, 26, 51, 0.18)"};var v=night?d:l;Object.keys(v).forEach(function(k){document.documentElement.style.setProperty(k,v[k]);});"""
    }
}
