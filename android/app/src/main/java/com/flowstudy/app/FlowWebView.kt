package com.flowstudy.app

import android.content.Context
import android.graphics.Rect
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebView

/**
 * 在系統的「反白選單」（複製／分享／全選那一排）最前面加一個「FlowStudy 翻譯」。
 *
 * 電腦上是反白後按 Z；手機沒有鍵盤，就從這個選單按。按下去等於替使用者按了一次 Z，
 * 後面的事交給原本的 web-lookup.js。
 */
class FlowWebView(context: Context) : WebView(context) {

    var onLookupSelection: ((ActionMode) -> Unit)? = null

    override fun startActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? =
        super.startActionMode(wrap(callback), type)

    override fun startActionMode(callback: ActionMode.Callback?): ActionMode? =
        super.startActionMode(wrap(callback))

    private fun wrap(callback: ActionMode.Callback?): ActionMode.Callback? {
        val inner = callback ?: return null
        val lookup = onLookupSelection ?: return inner
        return object : ActionMode.Callback2() {
            override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                val ok = inner.onCreateActionMode(mode, menu)
                menu.add(Menu.NONE, MENU_LOOKUP, 0, "FlowStudy 翻譯")
                return ok
            }

            override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean =
                inner.onPrepareActionMode(mode, menu)

            override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
                if (item.itemId == MENU_LOOKUP) {
                    lookup(mode)
                    return true
                }
                return inner.onActionItemClicked(mode, item)
            }

            override fun onDestroyActionMode(mode: ActionMode) = inner.onDestroyActionMode(mode)

            // 浮動選單要知道反白的位置才能出現在正確的地方，交給 WebView 原本的實作
            override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
                if (inner is ActionMode.Callback2) inner.onGetContentRect(mode, view, outRect)
                else super.onGetContentRect(mode, view, outRect)
            }
        }
    }

    companion object {
        private const val MENU_LOOKUP = 0x464C53 // "FLS"
    }
}
