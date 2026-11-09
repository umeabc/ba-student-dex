package com.sensei.studentdex

object BridgeShim {
    const val SCRIPT = "(function(){var w=window;if(w.webkit&&w.webkit.messageHandlers&&w.webkit.messageHandlers.ba)return;var n=w.__baNative;if(!n)return;function P(m){try{if(m&&m.op==='store'){n.store(m.id==null?'':String(m.id),m.action==null?'load':String(m.action),m.value==null?'':String(m.value));}else{n.rpc(JSON.stringify(m));}}catch(e){}}w.webkit={messageHandlers:{ba:{postMessage:P}}};})();"

    // web/styles.css sets `html, body { overflow-x: hidden }`. On Chromium the root then
    // becomes a scroll container whose box is as tall as the content, so the viewport
    // cannot be scrolled by touch (programmatic scrolling still works, which hides the
    // bug). Keeping body's clipping and freeing only <html> restores inertia scrolling.
    const val LAYOUT_CSS = "html{overflow:visible!important}"

    fun jsStringLiteral(value: String): String = value
        .replace("\\", "\\\\").replace("'", "\\'")
        .replace("\r", "\\r").replace("\n", "\\n")
        .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
}