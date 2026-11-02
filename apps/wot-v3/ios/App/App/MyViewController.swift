import Capacitor

/// The bridge view controller of Main.storyboard. The app's own plugins (src/platform/capacitor) are
/// registered here; the npm plugins register through `cap sync` (capacitor.config.json packageClassList).
class MyViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BiometricKeystorePlugin())
        bridge?.registerPluginInstance(ScreenProtectionPlugin())
        bridge?.registerPluginInstance(AppSettingsPlugin())
    }
}
