import Foundation
import Capacitor
import LocalAuthentication
import Security

/// A secret behind the device's biometrics or passcode (src/platform/capacitor/biometric.ts), the iOS
/// side of the Android plugin BiometricKeystorePlugin.java with the same interface:
/// - every call takes an `alias`: one keychain item per identity namespace (`wot_v3_<ns>`, the account
///   of the item; service org.reallife.weboftrust.biometric), so a new entry never replaces the access
///   to an older vault. Without `alias` only hasStoredPassphrase and deletePassphrase reach the Gen-2
///   item of apps/demo (service org.utopialab.weboftrust.biometric, account encrypted_passphrase);
///   unlocking or storing without alias is a contract violation (INVALID_ARGUMENT).
/// - the item is protected by SecAccessControl `.userPresence` (Face ID, Touch ID or the passcode) and
///   `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (never in a backup, never on another device), as in
///   Gen 2. A store writes the new item or updates the existing one in place: after a failure the old
///   item stays readable. Reading never changes anything.
/// - prompt texts come from the app (title, subtitle, cancel); the Gen-2 plugin hard-coded German.
/// - error codes: USER_CANCELLED (also errSecAuthFailed, as in Gen 2: the unlock flow offers the
///   passphrase after any failure), KEY_NOT_FOUND, AUTH_FAILED, INVALID_ARGUMENT. KEY_INVALIDATED does
///   not occur: `.userPresence` is not bound to the enrolled biometrics, a new face or finger keeps the
///   item readable (`.biometryCurrentSet` would invalidate it; Android's time-bound key behaves alike).
@objc(BiometricKeystorePlugin)
public class BiometricKeystorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BiometricKeystorePlugin"
    public let jsName = "BiometricKeystore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storePassphrase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlockPassphrase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePassphrase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasStoredPassphrase", returnType: CAPPluginReturnPromise),
    ]

    /// v3 items: one per identity namespace
    private static let service = "org.reallife.weboftrust.biometric"
    /// the Gen-2 item (apps/demo), reachable only to find and remove it
    private static let legacyService = "org.utopialab.weboftrust.biometric"
    private static let legacyAccount = "encrypted_passphrase"
    /// the alias rule of BiometricPolicy.java
    private static let aliasPattern = "^wot_v3_[A-Za-z0-9_-]{1,120}$"

    private struct Entry { let service: String; let account: String }

    /// the item a call names, or nil after rejecting the call as a contract violation
    private func entry(of call: CAPPluginCall, legacyAllowed: Bool) -> Entry? {
        let alias = call.getString("alias") ?? ""
        if alias.isEmpty {
            if legacyAllowed { return Entry(service: Self.legacyService, account: Self.legacyAccount) }
            call.reject("Invalid or missing alias", "INVALID_ARGUMENT")
            return nil
        }
        if alias.range(of: Self.aliasPattern, options: .regularExpression) == nil {
            call.reject("Invalid or missing alias", "INVALID_ARGUMENT")
            return nil
        }
        return Entry(service: Self.service, account: alias)
    }

    private func baseQuery(_ e: Entry) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: e.service,
            kSecAttrAccount as String: e.account,
        ]
    }

    /// an LAContext with the app's prompt texts
    private func context(for call: CAPPluginCall) -> LAContext {
        let ctx = LAContext()
        if let cancel = call.getString("cancel"), !cancel.isEmpty { ctx.localizedCancelTitle = cancel }
        return ctx
    }

    private func reason(for call: CAPPluginCall, default defaultTitle: String) -> String {
        let title = call.getString("title").flatMap { $0.isEmpty ? nil : $0 } ?? defaultTitle
        if let subtitle = call.getString("subtitle"), !subtitle.isEmpty { return "\(title)\n\(subtitle)" }
        return title
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        let ctx = LAContext()
        var error: NSError?
        let available = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
        var biometryType = "none"
        if available {
            var bioError: NSError?
            if ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &bioError) {
                switch ctx.biometryType {
                case .faceID: biometryType = "face"
                case .touchID: biometryType = "touch"
                default:
                    if #available(iOS 17.0, *), ctx.biometryType == .opticID { biometryType = "optic" } else { biometryType = "available" }
                }
            } else {
                // only the passcode is set up, no biometrics enrolled (Android: "credential")
                biometryType = "credential"
            }
        } else if let err = error, let code = LAError.Code(rawValue: err.code) {
            switch code {
            case .biometryNotEnrolled: biometryType = "not_enrolled"
            case .biometryNotAvailable, .passcodeNotSet: biometryType = "none"
            default: biometryType = "unavailable"
            }
        }
        call.resolve(["available": available, "biometryType": biometryType])
    }

    @objc func storePassphrase(_ call: CAPPluginCall) {
        guard let passphrase = call.getString("passphrase"), !passphrase.isEmpty else {
            call.reject("Passphrase is required", "INVALID_ARGUMENT")
            return
        }
        guard let e = entry(of: call, legacyAllowed: false) else { return }
        guard let data = passphrase.data(using: .utf8) else {
            call.reject("Failed to encode passphrase", "INVALID_ARGUMENT")
            return
        }
        let ctx = context(for: call)
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason(for: call, default: "Set up biometric unlock")) { success, error in
            guard success else {
                self.rejectPromptError(call, error)
                return
            }
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, nil) else {
                call.reject("Failed to create access control", "AUTH_FAILED")
                return
            }
            var add = self.baseQuery(e)
            add[kSecValueData as String] = data
            add[kSecAttrAccessControl as String] = access
            add[kSecUseAuthenticationContext as String] = ctx
            var status = SecItemAdd(add as CFDictionary, nil)
            if status == errSecDuplicateItem {
                // in place: the old item stays until the new value is written
                var query = self.baseQuery(e)
                query[kSecUseAuthenticationContext as String] = ctx
                let update: [String: Any] = [kSecValueData as String: data, kSecAttrAccessControl as String: access]
                status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
            }
            if status == errSecSuccess {
                call.resolve()
            } else {
                call.reject("Failed to store: \(status)", "AUTH_FAILED")
            }
        }
    }

    @objc func unlockPassphrase(_ call: CAPPluginCall) {
        guard let e = entry(of: call, legacyAllowed: false) else { return }
        let ctx = context(for: call)
        ctx.localizedReason = reason(for: call, default: "Unlock your identity")
        var query = baseQuery(e)
        query[kSecReturnData as String] = true
        query[kSecUseAuthenticationContext as String] = ctx
        query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIAllow
        // SecItemCopyMatching blocks while the system prompt shows; never on the main thread
        DispatchQueue.global(qos: .userInitiated).async {
            var result: AnyObject?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            switch status {
            case errSecSuccess:
                if let data = result as? Data, let passphrase = String(data: data, encoding: .utf8) {
                    call.resolve(["passphrase": passphrase])
                } else {
                    call.reject("Entry unreadable", "AUTH_FAILED")
                }
            case errSecUserCanceled, errSecAuthFailed:
                call.reject("User cancelled", "USER_CANCELLED")
            case errSecItemNotFound:
                call.reject("No stored passphrase found", "KEY_NOT_FOUND")
            default:
                call.reject("Unlock failed: \(status)", "AUTH_FAILED")
            }
        }
    }

    @objc func deletePassphrase(_ call: CAPPluginCall) {
        guard let e = entry(of: call, legacyAllowed: true) else { return }
        let status = SecItemDelete(baseQuery(e) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Could not remove the entry: \(status)", "AUTH_FAILED")
        }
    }

    @objc func hasStoredPassphrase(_ call: CAPPluginCall) {
        guard let e = entry(of: call, legacyAllowed: true) else { return }
        var query = baseQuery(e)
        // no prompt: an item that exists but needs authentication answers errSecInteractionNotAllowed
        query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        switch status {
        case errSecSuccess, errSecInteractionNotAllowed:
            call.resolve(["stored": true])
        case errSecItemNotFound:
            call.resolve(["stored": false])
        default:
            call.reject("Entry unreadable: \(status)", "AUTH_FAILED")
        }
    }

    private func rejectPromptError(_ call: CAPPluginCall, _ error: Error?) {
        if let la = error as? LAError {
            switch la.code {
            case .userCancel, .appCancel, .systemCancel, .userFallback:
                call.reject("User cancelled", "USER_CANCELLED")
                return
            default: break
            }
        }
        call.reject("Authentication failed: \(error?.localizedDescription ?? "unknown")", "AUTH_FAILED")
    }
}
