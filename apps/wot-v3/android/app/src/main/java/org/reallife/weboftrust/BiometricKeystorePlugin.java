package org.reallife.weboftrust;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;
import android.util.Base64;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * A secret behind the device's biometrics or screen lock (src/platform/capacitor/biometric.ts).
 *
 * Taken from apps/demo and brought to the v3 interface:
 * - every call takes an optional {@code alias}: one Keystore key and one stored entry per identity
 *   namespace ({@code wot_v3_<ns>}), so a new entry never replaces the access to an older vault.
 *   Without {@code alias} the Gen-2 entry {@code wot_biometric_key} is meant (its stored data keeps the
 *   Gen-2 preference names, so an updated Gen-2 install still finds it).
 * - prompt texts come from the app (title, subtitle); the Gen-2 plugin hard-coded German.
 *   {@code cancel} is not used on Android: with the screen lock as a second way the system shows its
 *   own button.
 * - error codes: USER_CANCELLED, KEY_INVALIDATED (the key is permanently invalid, e.g. the screen
 *   lock was removed; the entry is removed with it), KEY_NOT_FOUND (no entry or no key), AUTH_FAILED.
 *   The Gen-2 plugin never reported KEY_INVALIDATED (the exception only comes from Cipher.init).
 *
 * The key is time-bound (10 s after an authentication, BIOMETRIC_STRONG or DEVICE_CREDENTIAL), as in
 * Gen 2. For such keys Android does not invalidate on a newly enrolled fingerprint; it does when the
 * secure lock screen is turned off.
 */
@CapacitorPlugin(name = "BiometricKeystore")
public class BiometricKeystorePlugin extends Plugin {

    private static final String LEGACY_ALIAS = "wot_biometric_key";
    private static final String PREFS_NAME = "wot_biometric_prefs";
    private static final String LEGACY_PREF_CIPHERTEXT = "encrypted_passphrase";
    private static final String LEGACY_PREF_IV = "encryption_iv";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final int AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    /** the Keystore alias of a call; only the legacy one and wot_v3_* are accepted */
    private static String aliasOf(PluginCall call) {
        String alias = call.getString("alias");
        if (alias == null || alias.isEmpty()) return LEGACY_ALIAS;
        return alias;
    }

    private static boolean validAlias(String alias) {
        return LEGACY_ALIAS.equals(alias) || alias.matches("^wot_v3_[A-Za-z0-9._:-]{1,120}$");
    }

    private static String prefCiphertext(String alias) {
        return LEGACY_ALIAS.equals(alias) ? LEGACY_PREF_CIPHERTEXT : alias + ".ciphertext";
    }

    private static String prefIv(String alias) {
        return LEGACY_ALIAS.equals(alias) ? LEGACY_PREF_IV : alias + ".iv";
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int result = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        JSObject ret = new JSObject();
        ret.put("available", result == BiometricManager.BIOMETRIC_SUCCESS);
        String biometryType;
        switch (result) {
            case BiometricManager.BIOMETRIC_SUCCESS:
                biometryType = "available";
                break;
            case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                biometryType = "none";
                break;
            case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                biometryType = "unavailable";
                break;
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                biometryType = "not_enrolled";
                break;
            default:
                biometryType = "unknown";
        }
        ret.put("biometryType", biometryType);
        call.resolve(ret);
    }

    @PluginMethod
    public void storePassphrase(PluginCall call) {
        String passphrase = call.getString("passphrase");
        String alias = aliasOf(call);
        if (passphrase == null || passphrase.isEmpty()) {
            call.reject("Passphrase is required", "INVALID_ARGUMENT");
            return;
        }
        if (!validAlias(alias)) {
            call.reject("Invalid alias", "INVALID_ARGUMENT");
            return;
        }
        prompt(call, "Set up biometric unlock", new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                try {
                    SecretKey key = createKey(alias);
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.ENCRYPT_MODE, key);
                    byte[] ciphertext = cipher.doFinal(passphrase.getBytes(StandardCharsets.UTF_8));
                    byte[] iv = cipher.getIV();
                    boolean written = prefs().edit()
                        .putString(prefCiphertext(alias), Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                        .putString(prefIv(alias), Base64.encodeToString(iv, Base64.NO_WRAP))
                        .commit();
                    if (!written) {
                        call.reject("Could not write the entry", "AUTH_FAILED");
                        return;
                    }
                    call.resolve();
                } catch (Exception e) {
                    call.reject("Failed to store: " + e.getMessage(), "AUTH_FAILED");
                }
            }

            @Override
            public void onAuthenticationError(int errorCode, CharSequence errString) {
                rejectPromptError(call, errorCode, errString);
            }
        });
    }

    @PluginMethod
    public void unlockPassphrase(PluginCall call) {
        String alias = aliasOf(call);
        if (!validAlias(alias)) {
            call.reject("Invalid alias", "INVALID_ARGUMENT");
            return;
        }
        String ciphertextB64 = prefs().getString(prefCiphertext(alias), null);
        String ivB64 = prefs().getString(prefIv(alias), null);
        if (ciphertextB64 == null || ivB64 == null) {
            call.reject("No stored entry", "KEY_NOT_FOUND");
            return;
        }
        SecretKey key;
        try {
            key = loadKey(alias);
        } catch (Exception e) {
            call.reject("Keystore unavailable: " + e.getMessage(), "AUTH_FAILED");
            return;
        }
        if (key == null) {
            try {
                deleteEntry(alias);
            } catch (Exception ignored) {
                // the stored data without its key is useless; what remained shows in hasStoredPassphrase
            }
            call.reject("Key not found", "KEY_NOT_FOUND");
            return;
        }
        byte[] iv = Base64.decode(ivB64, Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(ciphertextB64, Base64.NO_WRAP);

        // An invalidated key is told before the prompt: Cipher.init throws
        // KeyPermanentlyInvalidatedException for it, UserNotAuthenticatedException for a valid key
        // that waits for the authentication.
        try {
            Cipher probe = Cipher.getInstance("AES/GCM/NoPadding");
            probe.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        } catch (KeyPermanentlyInvalidatedException e) {
            rejectInvalidated(call, alias);
            return;
        } catch (UserNotAuthenticatedException e) {
            // expected: the prompt follows
        } catch (Exception e) {
            // anything else shows again after the prompt
        }

        prompt(call, "Unlock your identity", new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                try {
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
                    byte[] plaintext = cipher.doFinal(ciphertext);
                    JSObject ret = new JSObject();
                    ret.put("passphrase", new String(plaintext, StandardCharsets.UTF_8));
                    call.resolve(ret);
                } catch (KeyPermanentlyInvalidatedException e) {
                    rejectInvalidated(call, alias);
                } catch (Exception e) {
                    call.reject("Decryption failed: " + e.getMessage(), "AUTH_FAILED");
                }
            }

            @Override
            public void onAuthenticationError(int errorCode, CharSequence errString) {
                rejectPromptError(call, errorCode, errString);
            }
        });
    }

    @PluginMethod
    public void deletePassphrase(PluginCall call) {
        String alias = aliasOf(call);
        if (!validAlias(alias)) {
            call.reject("Invalid alias", "INVALID_ARGUMENT");
            return;
        }
        try {
            if (!deleteEntry(alias)) {
                call.reject("Could not remove the entry", "AUTH_FAILED");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to delete: " + e.getMessage(), "AUTH_FAILED");
        }
    }

    @PluginMethod
    public void hasStoredPassphrase(PluginCall call) {
        String alias = aliasOf(call);
        if (!validAlias(alias)) {
            call.reject("Invalid alias", "INVALID_ARGUMENT");
            return;
        }
        SharedPreferences p = prefs();
        JSObject ret = new JSObject();
        ret.put("stored", p.contains(prefCiphertext(alias)) && p.contains(prefIv(alias)));
        call.resolve(ret);
    }

    private void prompt(PluginCall call, String defaultTitle, BiometricPrompt.AuthenticationCallback callback) {
        String title = call.getString("title", defaultTitle);
        String subtitle = call.getString("subtitle");
        getActivity().runOnUiThread(() -> {
            try {
                FragmentActivity activity = getActivity();
                BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title == null || title.isEmpty() ? defaultTitle : title)
                    .setAllowedAuthenticators(AUTHENTICATORS);
                if (subtitle != null && !subtitle.isEmpty()) info.setSubtitle(subtitle);
                new BiometricPrompt(activity, ContextCompat.getMainExecutor(getContext()), callback)
                    .authenticate(info.build());
            } catch (Exception e) {
                call.reject("Prompt failed: " + e.getMessage(), "AUTH_FAILED");
            }
        });
    }

    private static void rejectPromptError(PluginCall call, int errorCode, CharSequence errString) {
        if (errorCode == BiometricPrompt.ERROR_USER_CANCELED
            || errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
            || errorCode == BiometricPrompt.ERROR_CANCELED) {
            call.reject("User cancelled", "USER_CANCELLED");
        } else {
            call.reject("Authentication failed: " + errString, "AUTH_FAILED");
        }
    }

    private void rejectInvalidated(PluginCall call, String alias) {
        try {
            deleteEntry(alias);
        } catch (Exception ignored) {
            // the code below is what counts; a later hasStoredPassphrase tells what remained
        }
        call.reject("Key permanently invalidated, set up again", "KEY_INVALIDATED");
    }

    private SecretKey createKey(String alias) throws Exception {
        KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationValidityDurationSeconds(10)
            .setInvalidatedByBiometricEnrollment(true)
            .build();
        keyGenerator.init(spec);
        return keyGenerator.generateKey();
    }

    private static SecretKey loadKey(String alias) throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (!keyStore.containsAlias(alias)) return null;
        return (SecretKey) keyStore.getKey(alias, null);
    }

    /** removes the stored entry and the key of alias; true when both are gone */
    private boolean deleteEntry(String alias) throws Exception {
        boolean written = prefs().edit().remove(prefCiphertext(alias)).remove(prefIv(alias)).commit();
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias);
        return written && !keyStore.containsAlias(alias);
    }
}
