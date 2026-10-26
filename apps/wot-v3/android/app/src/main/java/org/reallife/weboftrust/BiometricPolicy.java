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

    /** the Gen-2 entry (apps/demo), reachable only to find and remove it */
    static final String LEGACY_ALIAS = "wot_biometric_key";

    private BiometricPolicy() {}

    /**
     * The entry a call names, or null for a contract violation. A v3 alias is {@code wot_v3_<ns>}
     * (letters, digits, '_' and '-'; no '.', which separates the stored fields). Without an alias the
     * Gen-2 entry is meant, and only where {@code legacyAllowed} (has, delete): unlocking or storing
     * never reaches it.
     */
    static String entryFor(String alias, boolean legacyAllowed) {
        if (alias == null || alias.isEmpty()) return legacyAllowed ? LEGACY_ALIAS : null;
        return alias.matches("^wot_v3_[A-Za-z0-9_-]{1,120}$") ? alias : null;
    }

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
