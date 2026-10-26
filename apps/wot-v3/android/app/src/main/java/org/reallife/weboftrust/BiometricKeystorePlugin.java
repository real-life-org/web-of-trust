package org.reallife.weboftrust;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
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
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * A secret behind the device's biometrics or screen lock (src/platform/capacitor/biometric.ts).
 *
 * Taken from apps/demo and brought to the v3 interface:
 * - every call takes an {@code alias}: one stored entry per identity namespace ({@code wot_v3_<ns>}),
 *   so a new entry never replaces the access to an older vault. Without {@code alias} only
 *   hasStoredPassphrase and deletePassphrase reach the Gen-2 entry {@code wot_biometric_key} (Gen-2
 *   preference names, so an updated Gen-2 install still finds it); unlocking or storing without alias
 *   is a contract violation (INVALID_ARGUMENT), never the Gen-2 entry.
 * - storing is write-then-swap (EntryReplacement): a fresh Keystore key per stored secret, the entry
 *   names its key and is replaced in one commit after the new key encrypted the secret; a failed or
 *   cancelled store leaves the old entry readable.
 * - prompt texts come from the app (title, subtitle, cancel); the Gen-2 plugin hard-coded German.
 *   {@code cancel} labels the negative button below Android 11; from Android 11 the screen lock is the
 *   second way and the system shows its own button.
 * - the authenticators follow BiometricPolicy (issue #442): strong biometrics or the screen lock from
 *   Android 11 (API 30), strong biometrics only below; the same value for canAuthenticate, the prompt
 *   and the Keystore key.
 * - error codes: USER_CANCELLED, KEY_INVALIDATED (the key is permanently invalid, e.g. the screen
 *   lock was removed; the entry is removed with it), KEY_NOT_FOUND (no entry or no key), AUTH_FAILED.
 *   The Gen-2 plugin never reported KEY_INVALIDATED (the exception only comes from Cipher.init).
 *
 * The key is time-bound (10 s after an authentication), as in Gen 2. For such keys Android does not
 * invalidate on a newly enrolled fingerprint; it does when the secure lock screen is turned off.
 */
@CapacitorPlugin(name = "BiometricKeystore")
public class BiometricKeystorePlugin extends Plugin {

    private static final String LEGACY_ALIAS = BiometricPolicy.LEGACY_ALIAS;
    private static final String PREFS_NAME = "wot_biometric_prefs";
    private static final String LEGACY_PREF_CIPHERTEXT = "encrypted_passphrase";
    private static final String LEGACY_PREF_IV = "encryption_iv";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final int API = Build.VERSION.SDK_INT;
    private static final int AUTHENTICATORS = BiometricPolicy.authenticatorsFor(API);

    private static String prefCiphertext(String alias) {
        return LEGACY_ALIAS.equals(alias) ? LEGACY_PREF_CIPHERTEXT : alias + ".ciphertext";
    }

    private static String prefIv(String alias) {
        return LEGACY_ALIAS.equals(alias) ? LEGACY_PREF_IV : alias + ".iv";
    }

    private static String prefKey(String alias) {
        return alias + ".key";
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** the Keystore key of an entry: the Gen-2 entry has its fixed key, a v3 entry names its own */
    private String keyNameOf(String alias) {
        if (LEGACY_ALIAS.equals(alias)) return LEGACY_ALIAS;
        return prefs().getString(prefKey(alias), null);
    }

    /** the entry of a call, or null after rejecting it as a contract violation */
    private static String entryOf(PluginCall call, boolean legacyAllowed) {
        String entry = BiometricPolicy.entryFor(call.getString("alias"), legacyAllowed);
        if (entry == null) call.reject("Invalid or missing alias", "INVALID_ARGUMENT");
        return entry;
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
        if (passphrase == null || passphrase.isEmpty()) {
            call.reject("Passphrase is required", "INVALID_ARGUMENT");
            return;
        }
        String alias = entryOf(call, false);
        if (alias == null) return;
        prompt(call, "Set up biometric unlock", new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                try {
                    EntryReplacement.replace(stepsFor(alias), passphrase.getBytes(StandardCharsets.UTF_8));
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

    private EntryReplacement.Steps stepsFor(String alias) {
        return new EntryReplacement.Steps() {
            @Override
            public String currentKey() {
                return keyNameOf(alias);
            }

            @Override
            public String freshKeyName() {
                return alias + "." + UUID.randomUUID().toString().replace("-", "");
            }

            @Override
            public void createKey(String keyName) throws Exception {
                BiometricKeystorePlugin.createKey(keyName);
            }

            @Override
            public byte[][] encrypt(String keyName, byte[] plain) throws Exception {
                SecretKey key = loadKey(keyName);
                if (key == null) throw new IllegalStateException("fresh key missing");
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key);
                return new byte[][] {cipher.doFinal(plain), cipher.getIV()};
            }

            @Override
            public boolean commit(String keyName, byte[] ciphertext, byte[] iv) {
                return prefs().edit()
                    .putString(prefCiphertext(alias), Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                    .putString(prefIv(alias), Base64.encodeToString(iv, Base64.NO_WRAP))
                    .putString(prefKey(alias), keyName)
                    .commit();
            }

            @Override
            public void deleteKey(String keyName) {
                try {
                    deleteKeystoreEntry(keyName);
                } catch (Exception ignored) {
                    // an orphaned key holds no secret; the entry names only the current one
                }
            }
        };
    }

    @PluginMethod
    public void unlockPassphrase(PluginCall call) {
        String alias = entryOf(call, false);
        if (alias == null) return;
        String ciphertextB64 = prefs().getString(prefCiphertext(alias), null);
        String ivB64 = prefs().getString(prefIv(alias), null);
        String keyName = keyNameOf(alias);
        if (ciphertextB64 == null || ivB64 == null || keyName == null) {
            call.reject("No stored entry", "KEY_NOT_FOUND");
            return;
        }
        SecretKey key;
        try {
            key = loadKey(keyName);
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
        String alias = entryOf(call, true);
        if (alias == null) return;
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
        String alias = entryOf(call, true);
        if (alias == null) return;
        SharedPreferences p = prefs();
        JSObject ret = new JSObject();
        ret.put("stored", p.contains(prefCiphertext(alias)) && p.contains(prefIv(alias)));
        call.resolve(ret);
    }

    private void prompt(PluginCall call, String defaultTitle, BiometricPrompt.AuthenticationCallback callback) {
        String title = call.getString("title", defaultTitle);
        String subtitle = call.getString("subtitle");
        String cancel = call.getString("cancel");
        getActivity().runOnUiThread(() -> {
            try {
                FragmentActivity activity = getActivity();
                BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title == null || title.isEmpty() ? defaultTitle : title)
                    .setAllowedAuthenticators(AUTHENTICATORS);
                if (subtitle != null && !subtitle.isEmpty()) info.setSubtitle(subtitle);
                if (BiometricPolicy.needsNegativeButton(API)) {
                    info.setNegativeButtonText(cancel == null || cancel.isEmpty() ? "Cancel" : cancel);
                }
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

    private static void createKey(String keyName) throws Exception {
        KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
            keyName,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            spec.setUserAuthenticationParameters(BiometricPolicy.KEY_VALIDITY_SECONDS, BiometricPolicy.keyAuthTypes(API));
        } else {
            spec.setUserAuthenticationValidityDurationSeconds(BiometricPolicy.KEY_VALIDITY_SECONDS);
        }
        keyGenerator.init(spec.build());
        keyGenerator.generateKey();
    }

    private static SecretKey loadKey(String keyName) throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (!keyStore.containsAlias(keyName)) return null;
        return (SecretKey) keyStore.getKey(keyName, null);
    }

    /** true when the Keystore has no key keyName any more */
    private static boolean deleteKeystoreEntry(String keyName) throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(keyName)) keyStore.deleteEntry(keyName);
        return !keyStore.containsAlias(keyName);
    }

    /** removes the stored entry and its key; true when both are gone */
    private boolean deleteEntry(String alias) throws Exception {
        String keyName = keyNameOf(alias);
        boolean written = prefs().edit().remove(prefCiphertext(alias)).remove(prefIv(alias)).remove(prefKey(alias)).commit();
        boolean keyGone = keyName == null || deleteKeystoreEntry(keyName);
        return written && keyGone;
    }
}
