import Foundation
import Capacitor
import UIKit

/// Screen protection (architecture §5 table, src/platform/capacitor/index.ts):
/// - setCoverInBackground: an opaque view over the window from `willResignActive` until
///   `didBecomeActive`, so the app switcher shows no content (the system takes its picture after
///   `willResignActive`).
/// - setSecure: iOS has no public way to forbid a screenshot or a recording of a view. The flag is only
///   remembered; the web layer keeps its cover, and the event "screenshotTaken"
///   (UIApplication.userDidTakeScreenshotNotification) tells the app that a picture was taken, so it
///   can say so. Android sets FLAG_SECURE instead and never sends the event.
@objc(ScreenProtectionPlugin)
public class ScreenProtectionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenProtectionPlugin"
    public let jsName = "ScreenProtection"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSecure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCoverInBackground", returnType: CAPPluginReturnPromise),
    ]

    private var secure = false
    private var cover = false
    private var coverView: UIView?
    private var observers: [NSObjectProtocol] = []

    public override func load() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.showCover()
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.hideCover()
        })
        observers.append(center.addObserver(forName: UIApplication.userDidTakeScreenshotNotification, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("screenshotTaken", data: [:])
        })
    }

    deinit {
        for o in observers { NotificationCenter.default.removeObserver(o) }
    }

    @objc func setSecure(_ call: CAPPluginCall) {
        secure = call.getBool("secure") ?? false
        call.resolve()
    }

    @objc func setCoverInBackground(_ call: CAPPluginCall) {
        cover = call.getBool("on") ?? false
        if !cover { DispatchQueue.main.async { self.hideCover() } }
        call.resolve()
    }

    private func showCover() {
        guard cover, coverView == nil, let window = bridge?.viewController?.view.window else { return }
        let view = UIView(frame: window.bounds)
        view.backgroundColor = UIColor.systemBackground
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.isUserInteractionEnabled = false
        window.addSubview(view)
        coverView = view
    }

    private func hideCover() {
        coverView?.removeFromSuperview()
        coverView = nil
    }
}
