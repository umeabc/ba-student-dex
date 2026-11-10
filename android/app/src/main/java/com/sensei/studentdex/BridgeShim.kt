package com.sensei.studentdex

object BridgeShim {
    const val SCRIPT = "(function(){var w=window;if(w.webkit&&w.webkit.messageHandlers&&w.webkit.messageHandlers.ba)return;var n=w.__baNative;if(!n)return;function P(m){try{if(m&&m.op==='store'){n.store(m.id==null?'':String(m.id),m.action==null?'load':String(m.action),m.value==null?'':String(m.value));}else{n.rpc(JSON.stringify(m));}}catch(e){}}w.webkit={messageHandlers:{ba:{postMessage:P}}};})();"

    // web/styles.css sets `html, body { overflow-x: hidden }`. On Chromium the root then
    // becomes a scroll container whose box is as tall as the content, so the viewport
    // cannot be scrolled by touch (programmatic scrolling still works, which hides the
    // bug). Keeping body's clipping and freeing only <html> restores inertia scrolling.
    const val LAYOUT_CSS = "html{overflow:visible!important}" +
        // web/styles.css lays .mcard out as a flex *row*, so the image and its caption
        // compete for width and the caption collapses into one character per line.
        // Force a column only in the Android shell; web/ stays untouched.
        ".mcard{flex-direction:column}"

    // Only scheduling hints: never rewrite src (including blob:) or intercept clicks.
    const val LAZY_IMAGES = "(function(){function f(){var l=document.querySelectorAll('img:not([data-lz])');for(var i=0;i<l.length;i++){l[i].setAttribute('data-lz','1');l[i].loading='lazy';l[i].decoding='async';}}if(document.readyState!=='loading')f();document.addEventListener('DOMContentLoaded',f);new MutationObserver(f).observe(document.documentElement,{childList:true,subtree:true});})();"

    fun jsStringLiteral(value: String): String = value
        .replace("\\", "\\\\").replace("'", "\\'")
        .replace("\r", "\\r").replace("\n", "\\n")
        .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
}