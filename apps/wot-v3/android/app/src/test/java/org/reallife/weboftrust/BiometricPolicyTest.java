package org.reallife.weboftrust;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.security.keystore.KeyProperties;

import androidx.biometric.BiometricManager.Authenticators;

import org.junit.Test;

/**
 * The authenticator rule of BiometricKeystorePlugin (issue #442). AndroidX Biometric documents
 * BIOMETRIC_STRONG | DEVICE_CREDENTIAL as unsupported before Android 11 (API 30); biometric 1.1.0
 * rejects it on API 28/29 (canAuthenticate -2, PromptInfo.Builder.build() throws). Below API 30 the
 * prompt therefore asks for strong biometrics only, with a cancel button, never for weak biometrics.
 */
public class BiometricPolicyTest {
    private static final int STRONG = Authenticators.BIOMETRIC_STRONG;
    private static final int STRONG_OR_CREDENTIAL = Authenticators.BIOMETRIC_STRONG | Authenticators.DEVICE_CREDENTIAL;

    @Test
    public void belowApi30OnlyStrongBiometrics() {
        for (int api = 26; api <= 29; api++) {
            assertEquals("API " + api, STRONG, BiometricPolicy.authenticatorsFor(api));
            assertFalse("API " + api, BiometricPolicy.allowsDeviceCredential(api));
            assertTrue("API " + api + " needs a negative button", BiometricPolicy.needsNegativeButton(api));
        }
    }

    @Test
    public void fromApi30StrongBiometricsOrScreenLock() {
        for (int api : new int[] {30, 31, 33, 34, 35, 36}) {
            assertEquals("API " + api, STRONG_OR_CREDENTIAL, BiometricPolicy.authenticatorsFor(api));
            assertTrue("API " + api, BiometricPolicy.allowsDeviceCredential(api));
            assertFalse("API " + api + " must not set a negative button with DEVICE_CREDENTIAL", BiometricPolicy.needsNegativeButton(api));
        }
    }

    @Test
    public void neverWeakBiometrics() {
        for (int api = 26; api <= 36; api++) {
            assertEquals("API " + api, 0, BiometricPolicy.authenticatorsFor(api) & Authenticators.BIOMETRIC_WEAK & ~Authenticators.BIOMETRIC_STRONG);
        }
    }

    @Test
    public void theGen2EntryOnlyForHasAndDelete() {
        // review 441-1 Minor 3: without alias, has/delete reach wot_biometric_key, unlock/store never
        assertEquals("wot_biometric_key", BiometricPolicy.entryFor(null, true));
        assertEquals("wot_biometric_key", BiometricPolicy.entryFor("", true));
        assertNull(BiometricPolicy.entryFor(null, false));
        assertNull(BiometricPolicy.entryFor("", false));
        // the Gen-2 name given as an alias is no v3 entry
        assertNull(BiometricPolicy.entryFor("wot_biometric_key", false));
        assertNull(BiometricPolicy.entryFor("wot_biometric_key", true));
    }

    @Test
    public void v3AliasesOnly() {
        assertEquals("wot_v3_n0123456789abcdef", BiometricPolicy.entryFor("wot_v3_n0123456789abcdef", false));
        assertEquals("wot_v3_n0123456789abcdef", BiometricPolicy.entryFor("wot_v3_n0123456789abcdef", true));
        // '.' separates the stored fields and the key names of an entry
        assertNull(BiometricPolicy.entryFor("wot_v3_n01.ciphertext", false));
        assertNull(BiometricPolicy.entryFor("other_alias", false));
        assertNull(BiometricPolicy.entryFor("wot_v3_", false));
    }

    @Test
    public void keystoreKeyMatchesThePrompt() {
        // API 30+: the key accepts exactly what the prompt offers (setUserAuthenticationParameters);
        // below: the time-bound key (setUserAuthenticationValidityDurationSeconds) is used after the
        // strong-biometric prompt
        for (int api = 26; api <= 29; api++) assertEquals("API " + api, 0, BiometricPolicy.keyAuthTypes(api));
        for (int api = 30; api <= 36; api++) {
            assertEquals("API " + api, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL, BiometricPolicy.keyAuthTypes(api));
        }
    }
}
