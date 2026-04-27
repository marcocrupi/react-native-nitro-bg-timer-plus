//
//  NitroBackgroundTimer.swift
//  NitroBackgroundTimer
//
//  Created by tconns94 on 8/21/2025.
//

import Foundation
import UIKit
import NitroModules

class NitroBackgroundTimer: HybridNitroBackgroundTimerSpec {

  private var bgTask: UIBackgroundTaskIdentifier = .invalid
  private var didEnterBackgroundObserver: NSObjectProtocol?
  private var timeoutTimers: [Int: Timer] = [:]
  private var intervalTimers: [Int: Timer] = [:]

  // Mutated and read exclusively from the main queue to avoid cross-thread races.
  private var isDisposed: Bool = false

  private static let logTag = "[NitroBgTimer]"

  override init() {
    super.init()
    installLifecycleObservers()
  }

  // MARK: - Telemetry
  private func logInfo(_ message: String) {
    print("\(Self.logTag) info: \(message)")
  }

  private func logWarn(_ message: String) {
    print("\(Self.logTag) warn: \(message)")
  }

  private func logDebug(_ message: String) {
    #if DEBUG
    print("\(Self.logTag) debug: \(message)")
    #endif
  }

  // MARK: - Lifecycle helpers
  private var hasActiveTimers: Bool {
    !timeoutTimers.isEmpty || !intervalTimers.isEmpty
  }

  private func installLifecycleObservers() {
    guard didEnterBackgroundObserver == nil else { return }

    didEnterBackgroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.handleDidEnterBackground()
    }
  }

  private func removeLifecycleObservers() {
    if let observer = didEnterBackgroundObserver {
      NotificationCenter.default.removeObserver(observer)
      didEnterBackgroundObserver = nil
    }
  }

  private func handleDidEnterBackground() {
    guard !isDisposed else { return }
    guard hasActiveTimers && bgTask == .invalid else { return }

    logDebug("App entered background with active timers and no background task; reacquiring")
    acquireBackgroundTask()
  }

  private func performOnMainSynchronously(_ work: () -> Void) {
    if Thread.isMainThread {
      work()
    } else {
      DispatchQueue.main.sync(execute: work)
    }
  }

  // MARK: - Background task helpers (always called on main queue)
  private func acquireBackgroundTask() {
    guard !isDisposed else { return }
    guard bgTask == .invalid else { return }

    var taskIdentifier: UIBackgroundTaskIdentifier = .invalid
    taskIdentifier = UIApplication.shared.beginBackgroundTask(withName: "NitroBgTimer") { [weak self] in
      self?.handleBackgroundTaskExpiration(taskIdentifier)
    }
    bgTask = taskIdentifier

    if bgTask == .invalid {
      logWarn("Failed to acquire background task")
    } else {
      logDebug("Background task acquired (activeTimers=\(timeoutTimers.count + intervalTimers.count))")
    }
  }

  private func handleBackgroundTaskExpiration(_ taskIdentifier: UIBackgroundTaskIdentifier) {
    performOnMainSynchronously {
      logWarn("Background task expiration handler fired — releasing background task identifier (timers preserved)")
      // Critical: do NOT call cleanupAll() here. iOS only requires us to end
      // the expired background task to avoid 0x8badf00d. Timer instances are
      // preserved so active timers can continue best-effort and reacquire a
      // new background task on the next background transition.
      endBackgroundTaskIfCurrent(taskIdentifier, reason: "expired")
    }
  }

  private func releaseBackgroundTaskIfNeeded() {
    if !hasActiveTimers {
      releaseBackgroundTask()
    }
  }

  private func releaseBackgroundTask() {
    endBackgroundTaskIfCurrent(bgTask, reason: "released")
  }

  private func endBackgroundTaskIfCurrent(_ taskIdentifier: UIBackgroundTaskIdentifier, reason: String) {
    guard taskIdentifier != .invalid else { return }
    guard bgTask == taskIdentifier else {
      logDebug("Ignoring stale background task \(reason) request")
      return
    }

    UIApplication.shared.endBackgroundTask(taskIdentifier)
    bgTask = .invalid
    logDebug("Background task \(reason)")
  }

  // MARK: - Centralized cleanup (must run on main queue)
  private func cleanupAll() {
    removeLifecycleObservers()
    timeoutTimers.values.forEach { $0.invalidate() }
    intervalTimers.values.forEach { $0.invalidate() }
    timeoutTimers.removeAll()
    intervalTimers.removeAll()
    releaseBackgroundTask()
  }

  // MARK: - Timeout
  func setTimeout(id: Double, duration: Double, callback: @escaping (Double) -> Void) {
    let intId = Int(id)

    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      if self.isDisposed {
        self.logWarn("setTimeout called on disposed instance, ignoring")
        return
      }

      // Clear existing timer with same ID (inline to avoid async race)
      if let existing = self.timeoutTimers[intId] {
        existing.invalidate()
        self.timeoutTimers.removeValue(forKey: intId)
      }

      self.acquireBackgroundTask()

      let timer = Timer(timeInterval: duration / 1000.0, repeats: false) { [weak self] _ in
        guard let self = self else { return }

        // Note on callback exception handling (asymmetric with Android):
        // The Android implementation wraps `callback(id)` in a try/catch to log
        // and swallow exceptions thrown by the user callback. The Swift side
        // cannot easily do the same because `callback` is a non-throwing
        // `(Double) -> Void` and Swift does not support catching C++/Obj-C
        // exceptions without an Obj-C++ bridge helper. We rely on Nitro's
        // `AsyncJSCallback` dispatcher to catch JS-level exceptions at the
        // bridge boundary (the callback is dispatched async via CallInvoker to
        // the JS thread). Tracked as a future improvement: add an explicit
        // Obj-C++ exception barrier for stricter parity with Android.
        callback(id)

        self.timeoutTimers.removeValue(forKey: intId)
        self.releaseBackgroundTaskIfNeeded()
      }
      RunLoop.main.add(timer, forMode: .common)

      self.timeoutTimers[intId] = timer
    }
  }

  func clearTimeout(id: Double) {
    let intId = Int(id)

    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      if self.isDisposed { return }

      if let timer = self.timeoutTimers[intId] {
        timer.invalidate()
        self.timeoutTimers.removeValue(forKey: intId)
        self.releaseBackgroundTaskIfNeeded()
      }
    }
  }

  // MARK: - Interval
  func setInterval(id: Double, interval: Double, callback: @escaping (Double) -> Void) {
    let intId = Int(id)

    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      if self.isDisposed {
        self.logWarn("setInterval called on disposed instance, ignoring")
        return
      }

      if let existing = self.intervalTimers[intId] {
        existing.invalidate()
        self.intervalTimers.removeValue(forKey: intId)
      }

      self.acquireBackgroundTask()

      let timer = Timer(timeInterval: interval / 1000.0, repeats: true) { [weak self] _ in
        guard let self = self else { return }
        // If the interval has been cleared while the fire was pending, bail out.
        guard self.intervalTimers[intId] != nil else { return }

        // See the setTimeout callback-invocation comment for the rationale on
        // why this call is not wrapped in a try/catch (Swift-side asymmetry
        // with Android, deferred to a future Obj-C++ exception barrier).
        callback(id)
      }
      RunLoop.main.add(timer, forMode: .common)

      self.intervalTimers[intId] = timer
    }
  }

  func clearInterval(id: Double) {
    let intId = Int(id)

    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      if self.isDisposed { return }

      if let timer = self.intervalTimers[intId] {
        timer.invalidate()
        self.intervalTimers.removeValue(forKey: intId)
        self.releaseBackgroundTaskIfNeeded()
      }
    }
  }

  // MARK: - Background mode API (Android-only, no-op on iOS)
  //
  // iOS does not need a foreground-service equivalent: the main run loop
  // keeps Timer instances firing as long as the background task identifier
  // is alive (see `acquireBackgroundTask` above). The fix in commit 06eaa066
  // (B8 step 1) already brought iOS background accuracy to 100%.
  //
  // These methods exist only for spec parity so consumers can write
  // cross-platform code without platform branches.
  func startBackgroundMode() {
    logInfo("startBackgroundMode called on iOS — no-op (iOS handles background scheduling natively)")
  }

  func stopBackgroundMode() {
    logInfo("stopBackgroundMode called on iOS — no-op")
  }

  func configure(configJson: String) {
    logInfo("configure called on iOS — no-op (notification config is Android-only)")
  }

  func disableForegroundService() {
    logInfo("disableForegroundService called on iOS — no-op (iOS has no foreground service concept)")
  }

  // MARK: - Dispose (manual, JS-triggered)
  //
  // Overrides the default no-op from `HybridObject`. After `dispose()` is invoked
  // the instance is permanently unusable — subsequent calls to the timer API are
  // silently ignored (with a warning log) on this native side, while the JS wrapper
  // enforces the error surface for `setTimeout`/`setInterval`.
  func dispose() {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      if self.isDisposed {
        self.logWarn("dispose() called on already-disposed instance, ignoring")
        return
      }
      self.logInfo("dispose() triggered cleanup")
      self.isDisposed = true
      self.cleanupAll()
    }
  }

  // MARK: - Deinit (GC fallback when JS never calls dispose())
  deinit {
    // Copy out all values so the closure does not capture self (refcount 0 during deinit).
    // Dictionary is a value type in Swift, so this is a safe copy.
    let timeouts = timeoutTimers
    let intervals = intervalTimers
    let task = bgTask
    let observer = didEnterBackgroundObserver
    let alreadyDisposed = isDisposed

    #if DEBUG
    print("\(Self.logTag) debug: deinit triggered (alreadyDisposed=\(alreadyDisposed))")
    #endif

    if alreadyDisposed {
      // cleanupAll() has already run via dispose() — nothing to do.
      if let observer = observer {
        NotificationCenter.default.removeObserver(observer)
      }
      return
    }

    let doCleanup = {
      if let observer = observer {
        NotificationCenter.default.removeObserver(observer)
      }
      timeouts.values.forEach { $0.invalidate() }
      intervals.values.forEach { $0.invalidate() }
      if task != .invalid {
        UIApplication.shared.endBackgroundTask(task)
      }
    }

    if Thread.isMainThread {
      doCleanup()
    } else {
      // sync ensures all timers are invalidated and bgTask ended before dealloc completes.
      // Deadlock-safe: this branch only runs when NOT on the main thread.
      DispatchQueue.main.sync { doCleanup() }
    }
  }
}
