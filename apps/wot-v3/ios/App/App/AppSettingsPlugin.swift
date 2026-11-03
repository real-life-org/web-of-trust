import Foundation
import Capacitor
import UIKit

/// Opens the app's page in the Settings app (src/platform/capacitor/scanner.ts openAppSettings).
/// iOS has one page per app: permissions and, because the app ships two localizations
/// (CFBundleLocalizations), its "Language" row; `page` ("app" or "language") therefore opens the same
/// page. The Android plugin opens the per-app language settings for "language" on Android 13+.
@objc(AppSettingsPlugin)
public class AppSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppSettingsPlugin"
    public let jsName = "AppSettings"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
    ]

    @objc func open(_ call: CAPPluginCall) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            call.reject("No settings page", "UNAVAILABLE")
            return
        }
        DispatchQueue.main.async {
            guard UIApplication.shared.canOpenURL(url) else {
                call.reject("No settings page", "UNAVAILABLE")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("No settings page", "UNAVAILABLE") }
            }
        }
    }
}
