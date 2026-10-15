package com.nitrobgtimerexample

import android.app.NotificationManager
import android.os.Handler
import android.os.Looper
import android.os.Process
import com.facebook.react.ReactApplication
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.ViewManager
import org.json.JSONArray
import org.json.JSONObject

/** Example-only QA control. No exported component, private-field access or runtime mutation. */
class PhysicalQAPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
    listOf(PhysicalQA(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

class PhysicalQA(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  companion object {
    private var authorizedRun = ""
    private var previousRuntime = ""
    private var previousContext = 0
    private var previousWorkers = JSONArray()
    private var reloads = 0
    private var pendingUrl: String? = null
  }
  private val probeHandler = Handler(Looper.getMainLooper())
  private var pendingProbe: Runnable? = null
  override fun getName() = "NitroBgPhysicalQA"
  private fun check(runId: String) {
    require(runId == authorizedRun && runId.matches(Regex("[A-Za-z0-9._-]{1,80}"))) { "QA authorization missing" }
  }
  private fun workers(): JSONArray = JSONArray(Thread.getAllStackTraces().keys
    .filter { it.isAlive && it.name == "NitroBgTimer-Worker" }
    .map { JSONObject(mapOf("id" to it.id, "name" to it.name, "state" to it.state.toString())) })

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun activate(runId: String): String {
    require(runId.matches(Regex("[A-Za-z0-9._-]{1,80}")))
    require(authorizedRun.isEmpty() || authorizedRun == runId) { "fresh process required" }
    authorizedRun = runId
    return snapshot(runId)
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun snapshot(runId: String): String {
    check(runId)
    val manager = context.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as NotificationManager
    val notifications = manager.activeNotifications.map { n -> JSONObject(mapOf(
      "id" to n.id, "title" to n.notification.extras.getCharSequence("android.title")?.toString(),
      "text" to n.notification.extras.getCharSequence("android.text")?.toString(),
      "channel" to n.notification.channelId)) }
    return JSONObject(mapOf("pid" to Process.myPid(), "activity" to System.identityHashCode(context.currentActivity),
      "context" to System.identityHashCode(context), "workers" to workers(),
      "notifications" to JSONArray(notifications), "reloads" to reloads,
      "previousRuntime" to previousRuntime, "previousContext" to previousContext,
      "previousWorkers" to previousWorkers)).toString()
  }
  @ReactMethod
  fun scheduleProbe(runId: String, delayMs: Double) {
    check(runId)
    require(delayMs.isFinite() && delayMs >= 0 && delayMs <= 30000)
    pendingProbe?.let { probeHandler.removeCallbacks(it) }
    val task = Runnable { context.emitDeviceEvent("NitroBgPhysicalProbe", runId) }
    pendingProbe = task
    probeHandler.postDelayed(task, delayMs.toLong())
  }
  @ReactMethod
  fun cancelProbe(runId: String) {
    check(runId)
    pendingProbe?.let { probeHandler.removeCallbacks(it) }
    pendingProbe = null
  }
  override fun invalidate() {
    pendingProbe?.let { probeHandler.removeCallbacks(it) }
    pendingProbe = null
    super.invalidate()
  }
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun consumeResumeUrl(): String? {
    val url = pendingUrl
    pendingUrl = null
    return url
  }
  @ReactMethod
  fun recreate(runId: String) {
    check(runId)
    Handler(Looper.getMainLooper()).postDelayed({ context.currentActivity?.recreate() }, 200)
  }
  @ReactMethod
  fun reload(runId: String, runtime: String, url: String) {
    check(runId)
    require(url.startsWith("nitrobgtimerexample://smoke?runId=$runId&mode=qa&scenario=reload&"))
    pendingUrl = url
    previousRuntime = runtime
    previousContext = System.identityHashCode(context)
    previousWorkers = workers()
    reloads += 1
    Handler(Looper.getMainLooper()).postDelayed({
      (context.applicationContext as ReactApplication).reactHost!!.reload("Physical QA $runId")
    }, 200)
  }
}
