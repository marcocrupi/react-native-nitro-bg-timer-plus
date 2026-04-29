import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import UserNotifications

@objc(NitroBgSmokeLog)
final class NitroBgSmokeLog: NSObject, RCTBridgeModule {
  private static let pendingSmokeUrlLock = NSObject()
  private static var pendingSmokeUrl: String?
  private static let emptyCString = strdup("")!
  private static let logMethodCString = strdup("log:")!
  private static let consumePendingSmokeUrlMethodCString = strdup("consumePendingSmokeUrl")!
  private static let logMethodInfoPointer: UnsafePointer<RCTMethodInfo> = {
    let pointer = UnsafeMutablePointer<RCTMethodInfo>.allocate(capacity: 1)
    pointer.initialize(to: RCTMethodInfo(
      jsName: emptyCString,
      objcName: logMethodCString,
      isSync: false
    ))
    return UnsafePointer(pointer)
  }()
  private static let consumePendingSmokeUrlMethodInfoPointer: UnsafePointer<RCTMethodInfo> = {
    let pointer = UnsafeMutablePointer<RCTMethodInfo>.allocate(capacity: 1)
    pointer.initialize(to: RCTMethodInfo(
      jsName: emptyCString,
      objcName: consumePendingSmokeUrlMethodCString,
      isSync: true
    ))
    return UnsafePointer(pointer)
  }()

  @objc
  static func moduleName() -> String! {
    "NitroBgSmokeLog"
  }

  @objc
  static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc(log:)
  func log(_ message: String) {
    NSLog("%@", NitroBgSmokeLog.format(message))
  }

  @objc(__rct_export__log)
  static func exportLogMethod() -> UnsafePointer<RCTMethodInfo> {
    logMethodInfoPointer
  }

  @objc(consumePendingSmokeUrl)
  func consumePendingSmokeUrl() -> String? {
    Self.takePendingSmokeUrl()
  }

  @objc(__rct_export__consumePendingSmokeUrl)
  static func exportConsumePendingSmokeUrlMethod() -> UnsafePointer<RCTMethodInfo> {
    consumePendingSmokeUrlMethodInfoPointer
  }

  static func storePendingSmokeUrl(_ url: URL) {
    guard isSmokeUrl(url) else {
      return
    }

    objc_sync_enter(pendingSmokeUrlLock)
    pendingSmokeUrl = sanitizeSmokeUrl(url)
    objc_sync_exit(pendingSmokeUrlLock)
  }

  private static func takePendingSmokeUrl() -> String? {
    objc_sync_enter(pendingSmokeUrlLock)
    let url = pendingSmokeUrl
    pendingSmokeUrl = nil
    objc_sync_exit(pendingSmokeUrlLock)

    return url
  }

  private static func isSmokeUrl(_ url: URL) -> Bool {
    guard url.scheme == "nitrobgtimerexample" else {
      return false
    }

    if url.host == "smoke" {
      return true
    }

    return url.path
      .trimmingCharacters(in: CharacterSet(charactersIn: "/")) == "smoke"
  }

  private static func sanitizeSmokeUrl(_ url: URL) -> String {
    let compact = url.absoluteString.replacingOccurrences(
      of: "\\s+",
      with: "_",
      options: .regularExpression
    )
    let sanitized = compact.replacingOccurrences(
      of: "[^A-Za-z0-9_.:/?&=%+-]",
      with: "_",
      options: .regularExpression
    )

    return String(sanitized.prefix(512))
  }

  private static func format(_ message: String) -> String {
    let singleLine = message
      .replacingOccurrences(of: "\n", with: " ")
      .replacingOccurrences(of: "\r", with: " ")
    let limited = String(singleLine.prefix(1000))

    if limited.hasPrefix("[NitroBgSmoke]") {
      return limited
    }

    return "[NitroBgSmoke] \(limited.isEmpty ? "empty" : limited)"
  }
}

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if let url = launchOptions?[.url] as? URL {
      logSmokeNativeUrl("LAUNCH_URL", url: url)
    }

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "NitroBgTimerExample",
      in: window,
      launchOptions: launchOptions
    )

    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .sound, .badge]
    ) { _, _ in }

    return true
  }

  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    logSmokeNativeUrl("OPEN_URL", url: url)
    return RCTLinkingManager.application(app, open: url, options: options)
  }

  private func logSmokeNativeUrl(_ event: String, url: URL) {
    NitroBgSmokeLog.storePendingSmokeUrl(url)
    NSLog("[NitroBgSmokeNative] %@ url=%@", event, sanitizeSmokeUrlForLog(url))
  }

  private func sanitizeSmokeUrlForLog(_ url: URL) -> String {
    let compact = url.absoluteString.replacingOccurrences(
      of: "\\s+",
      with: "_",
      options: .regularExpression
    )
    let sanitized = compact.replacingOccurrences(
      of: "[^A-Za-z0-9_.:/?&=%+-]",
      with: "_",
      options: .regularExpression
    )
    let limited = String(sanitized.prefix(180))

    return limited.isEmpty ? "empty" : limited
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  @objc(extraModulesForBridge:)
  override func extraModules(for bridge: RCTBridge) -> [RCTBridgeModule] {
    NSLog("[NitroBgSmokeNative] EXTRA_MODULES registered=NitroBgSmokeLog")
    return [NitroBgSmokeLog()]
  }

  @objc(getModuleClassFromName:)
  func getModuleClassFromName(_ name: UnsafePointer<CChar>) -> AnyClass? {
    if String(cString: name) == "NitroBgSmokeLog" {
      return NitroBgSmokeLog.self
    }

    return nil
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
