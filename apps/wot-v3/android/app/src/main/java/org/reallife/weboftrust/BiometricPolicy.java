package org.reallife.weboftrust;

import android.security.keystore.KeyProperties;

import androidx.biometric.BiometricManager.Authenticators;

/**
 * Which authenticators the biometric unlock uses, by API level (pure; BiometricPolicyTest).
 *
 * AndroidX Biometric documents BIOMETRIC_STRONG | DEVICE_CREDENTIAL as unsupported before Android 11
 * (API 30); biometric 1.1.0 rejects it on API 28/29 (canAuthenticate -2, PromptInfo.Builder.build()
 * throws), issue #442. The rule:
 * - API 30+: strong biometrics or the screen lock; no negative button (the system shows its own); the
 *   Keystore key accepts exactly these (setUserAuthenticationParameters).
 * - below API 30: strong biometrics only, with a negative button (required without DEVICE_CREDENTIAL);
 *   the key is time-bound (setUserAuthenticationValidityDurationSeconds), used right after the prompt.
 * Never weak biometrics. The same value goes to canAuthenticate and to the prompt.
 */
final class BiometricPolicy {
    static final int API_CREDENTIAL_COMBINATION = 30;
    /** seconds the key stays usable after an authentication */
    static final int KEY_VALIDITY_SECONDS = 10;

    private BiometricPolicy() {}

    static boolean allowsDeviceCredential(int apiLevel) {
        return apiLevel >= API_CREDENTIAL_COMBINATION;
    }

    static int authenticatorsFor(int apiLevel) {
        return allowsDeviceCredential(apiLevel)
            ? Authenticators.BIOMETRIC_STRONG | Authenticators.DEVICE_CREDENTIAL
            : Authenticators.BIOMETRIC_STRONG;
    }

    static boolean needsNegativeButton(int apiLevel) {
        return !allowsDeviceCredential(apiLevel);
    }

    /** the KeyProperties.AUTH_* mask for setUserAuthenticationParameters (API 30+); 0 below */
    static int keyAuthTypes(int apiLevel) {
        return allowsDeviceCredential(apiLevel) ? KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL : 0;
    }
}
