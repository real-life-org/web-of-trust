import Foundation
import Capacitor
import LocalAuthentication
import Security

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

    private let keychainService = "org.utopialab.weboftrust.biometric"
    private let keychainAccount = "encrypted_passphrase"

    @objc func isAvailable(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)

        var biometryType = "none"
        if available {
            switch context.biometryType {
            case .faceID:
                biometryType = "face"
            case .touchID:
                biometryType = "touch"
            case .opticID:
                biometryType = "optic"
            default:
                biometryType = "available"
            }
        }

        call.resolve([
            "available": available,
            "biometryType": biometryType,
        ])
    }

    @objc func storePassphrase(_ call: CAPPluginCall) {
        guard let passphrase = call.getString("passphrase"), !passphrase.isEmpty else {
            call.reject("Passphrase is required")
            return
        }

        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Biometrie einrichten") { success, error in
            if !success {
                call.reject("Authentication cancelled", "USER_CANCELLED")
                return
            }

            guard let data = passphrase.data(using: .utf8) else {
                call.reject("Failed to encode passphrase")
                return
            }

            // Delete existing entry first
            self.deleteKeychainItem()

            // Create access control: requires biometry or device passcode
            guard let accessControl = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                .userPresence,
                nil
            ) else {
                call.reject("Failed to create access control")
                return
            }

            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: self.keychainService,
                kSecAttrAccount as String: self.keychainAccount,
                kSecValueData as String: data,
                kSecAttrAccessControl as String: accessControl,
            ]

            let status = SecItemAdd(query as CFDictionary, nil)
            if status == errSecSuccess {
                call.resolve()
            } else {
                call.reject("Failed to store passphrase: \(status)")
            }
        }
    }

    @objc func unlockPassphrase(_ call: CAPPluginCall) {
        let context = LAContext()
        context.localizedFallbackTitle = "Passwort eingeben"

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecUseAuthenticationContext as String: context,
            kSecUseOperationPrompt as String: "Identität entsperren",
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecSuccess, let data = result as? Data, let passphrase = String(data: data, encoding: .utf8) {
            call.resolve(["passphrase": passphrase])
        } else if status == errSecUserCanceled || status == errSecAuthFailed {
            call.reject("User cancelled", "USER_CANCELLED")
        } else if status == errSecItemNotFound {
            call.reject("No stored passphrase found", "KEY_NOT_FOUND")
        } else {
            call.reject("Unlock failed: \(status)")
        }
    }

    @objc func deletePassphrase(_ call: CAPPluginCall) {
        deleteKeychainItem()
        call.resolve()
    }

    @objc func hasStoredPassphrase(_ call: CAPPluginCall) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
        ]

        let status = SecItemCopyMatching(query as CFDictionary, nil)
        // errSecInteractionNotAllowed means the item exists but needs auth
        let stored = (status == errSecSuccess || status == errSecInteractionNotAllowed)
        call.resolve(["stored": stored])
    }

    private func deleteKeychainItem() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
