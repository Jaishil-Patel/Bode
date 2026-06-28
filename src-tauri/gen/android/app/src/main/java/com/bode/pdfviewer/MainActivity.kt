package com.bode.pdfviewer

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject
import java.io.File

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  // Path of a file the app was launched/asked to open, waiting until the web frontend is ready.
  private var pendingPath: String? = null
  private var jsReady = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    handleIntent(intent) // cold start: opened via "Open with" / a PDF tap
  }

  // singleTask launch mode routes a new "Open with" here while Bode is already running.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleIntent(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "BodeAndroid")
  }

  /** Bridge the frontend calls to fetch a file the app was cold-launched with. */
  inner class Bridge {
    @JavascriptInterface
    fun ready(): String? {
      jsReady = true
      val p = pendingPath
      pendingPath = null
      return p
    }
  }

  private fun handleIntent(intent: Intent?) {
    if (intent == null) return
    val uri: Uri = when (intent.action) {
      Intent.ACTION_VIEW -> intent.data
      Intent.ACTION_SEND -> getStreamExtra(intent)
      else -> null
    } ?: return
    // std::fs (used by the read_file_bytes command) can't read a content:// URI, so copy the
    // bytes into our cache dir and pass that real path to the frontend instead.
    val path = copyToCache(uri) ?: return
    if (jsReady) deliver(path) else pendingPath = path
  }

  /** Push the path to the already-running frontend (warm start). */
  private fun deliver(path: String) {
    val wv = webView ?: run { pendingPath = path; return }
    val js = "window.__bodeOpenFile && window.__bodeOpenFile(${JSONObject.quote(path)})"
    wv.post { wv.evaluateJavascript(js, null) }
  }

  @Suppress("DEPRECATION")
  private fun getStreamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else
      intent.getParcelableExtra(Intent.EXTRA_STREAM)

  /** Copy the content URI into cacheDir/opened/<name> and return its absolute path. */
  private fun copyToCache(uri: Uri): String? {
    return try {
      val dir = File(cacheDir, "opened").apply { mkdirs() }
      val out = File(dir, displayName(uri))
      contentResolver.openInputStream(uri)?.use { input ->
        out.outputStream().use { input.copyTo(it) }
      } ?: return null
      out.absolutePath
    } catch (e: Exception) {
      Log.e("Bode", "Failed to copy opened PDF into cache", e)
      null
    }
  }

  /** Best-effort original filename so the tab/title reads naturally; falls back to a default. */
  private fun displayName(uri: Uri): String {
    if (uri.scheme == "content") {
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst() && c.columnCount > 0) {
          val name = c.getString(0)
          if (!name.isNullOrBlank()) return name
        }
      }
    }
    return uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "document.pdf"
  }
}
