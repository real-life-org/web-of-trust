import Foundation
import Capacitor
import UIKit

/// Screen protection (architecture §5 table, src/platform/capacitor/index.ts):
/// - The app-switcher cover: a view over the window from `willResignActive` until `didBecomeActive`
///   (the system takes its picture after `willResignActive`), whenever an identity is open
///   (`setCoverInBackground`) or a sensitive screen shows (`setSecure`, the magic words and passphrase
///   fields, also during the onboarding before an identity exists). The rule of the web cover
///   (platform/web/identity.ts): sensitive || identity open.
/// - Its look is the web cover's (the lock and welcome screens): the app background, the network symbol
///   in a 64 pt circle tinted with the primary colour, the app name, one muted line in the app's
///   language (`setCoverText`); light or dark after the system appearance.
/// - setSecure: iOS has no public way to forbid a screenshot or a recording of a view; besides the
///   cover the flag changes nothing. The event "screenshotTaken"
///   (UIApplication.userDidTakeScreenshotNotification) tells the app that a picture was taken.
///   Android sets FLAG_SECURE instead and never sends the event.
@objc(ScreenProtectionPlugin)
public class ScreenProtectionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenProtectionPlugin"
    public let jsName = "ScreenProtection"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSecure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCoverInBackground", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCoverText", returnType: CAPPluginReturnPromise),
    ]

    // written on the plugin queue, read on the main queue: every access goes through the main queue
    private var secure = false
    private var cover = false
    private var appName = "Web of Trust"
    private var sensitiveLine = ""
    private var backgroundLine = ""
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
        let on = call.getBool("secure") ?? false
        DispatchQueue.main.async {
            self.secure = on
            if !self.cover && !on { self.hideCover() }
        }
        call.resolve()
    }

    @objc func setCoverInBackground(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            self.cover = on
            if !on && !self.secure { self.hideCover() }
        }
        call.resolve()
    }

    @objc func setCoverText(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        let sensitive = call.getString("sensitive") ?? ""
        let background = call.getString("background") ?? ""
        DispatchQueue.main.async {
            if !name.isEmpty { self.appName = name }
            self.sensitiveLine = sensitive
            self.backgroundLine = background
        }
        call.resolve()
    }

    // MARK: the cover

    private func showCover() {
        guard cover || secure else { return }
        guard coverView == nil, let window = bridge?.viewController?.view.window else { return }
        let view = makeCover(frame: window.bounds, line: secure ? sensitiveLine : backgroundLine)
        window.addSubview(view)
        coverView = view
    }

    private func hideCover() {
        coverView?.removeFromSuperview()
        coverView = nil
    }

    /// sRGB of the design tokens (tokens.css, oklch converted): light, dark
    private static func color(_ light: (CGFloat, CGFloat, CGFloat), _ dark: (CGFloat, CGFloat, CGFloat), alpha: CGFloat = 1) -> UIColor {
        return UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0 / 255, green: c.1 / 255, blue: c.2 / 255, alpha: alpha)
        }
    }
    private static let background = color((247, 248, 250), (7, 11, 20))
    private static let foreground = color((26, 27, 28), (233, 239, 245))
    private static let muted = color((80, 82, 87), (154, 159, 164))
    /// --primary-strong: primary-700 in light, the primary in dark
    private static let primaryStrong = color((38, 83, 193), (82, 135, 255))
    /// the primary at 10 % over the background (color-mix in the web cover)
    private static let primaryTint = color((46, 100, 234), (82, 135, 255), alpha: 0.10)

    private func makeCover(frame: CGRect, line: String) -> UIView {
        let root = UIView(frame: frame)
        root.backgroundColor = Self.background
        root.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.isUserInteractionEnabled = false
        root.accessibilityElementsHidden = true

        let circle = UIView()
        circle.backgroundColor = Self.primaryTint
        circle.layer.cornerRadius = 32
        circle.translatesAutoresizingMaskIntoConstraints = false
        let symbol = CAShapeLayer()
        symbol.frame = CGRect(x: 17, y: 17, width: 30, height: 30)
        symbol.path = Self.coverLogoPath(size: 30)
        symbol.strokeColor = Self.primaryStrong.resolvedColor(with: root.traitCollection).cgColor
        symbol.fillColor = Self.primaryStrong.resolvedColor(with: root.traitCollection).cgColor
        symbol.lineWidth = 2 * 30 / 23
        symbol.lineCap = .round
        symbol.lineJoin = .round
        circle.layer.addSublayer(symbol)

        let nameLabel = UILabel()
        nameLabel.text = appName
        nameLabel.font = .systemFont(ofSize: 22, weight: .bold)
        nameLabel.textColor = Self.foreground
        nameLabel.textAlignment = .center

        let lineLabel = UILabel()
        lineLabel.text = line
        lineLabel.font = .systemFont(ofSize: 14)
        lineLabel.textColor = Self.muted
        lineLabel.textAlignment = .center
        lineLabel.numberOfLines = 0
        lineLabel.isHidden = line.isEmpty

        let stack = UIStackView(arrangedSubviews: [circle, nameLabel, lineLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            circle.widthAnchor.constraint(equalToConstant: 64),
            circle.heightAnchor.constraint(equalToConstant: 64),
            stack.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: root.leadingAnchor, constant: 24),
            lineLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 320),
        ])
        root.layoutIfNeeded()
        return root
    }

    /// The network symbol of the web cover (platform/web/identity.ts coverLogo, viewBox 0 1 23 22):
    /// three filled nodes and their three edges, scaled to `size`.
    private static func coverLogoPath(size: CGFloat) -> CGPath {
        let k = size / 23
        let p = { (x: CGFloat, y: CGFloat) in CGPoint(x: x * k, y: (y - 1) * k) }
        let path = CGMutablePath()
        for (x, y) in [(18.72, 8.82), (5.28, 5.28), (8.82, 18.72)] as [(CGFloat, CGFloat)] {
            let c = p(x, y)
            path.addEllipse(in: CGRect(x: c.x - 2.5 * k, y: c.y - 2.5 * k, width: 5 * k, height: 5 * k))
        }
        for (x1, y1, x2, y2) in [(6.04, 8.18, 8.06, 15.82), (15.81, 8.05, 8.18, 6.04), (16.59, 10.94, 10.94, 16.59)] as [(CGFloat, CGFloat, CGFloat, CGFloat)] {
            path.move(to: p(x1, y1))
            path.addLine(to: p(x2, y2))
        }
        return path
    }
}
