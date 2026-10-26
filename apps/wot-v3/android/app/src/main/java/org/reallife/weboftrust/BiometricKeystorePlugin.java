package org.reallife.weboftrust;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;
import android.util.AtomicFile;
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

import org.json.JSONObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
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
 * - every call takes an {@code alias}: one entry per identity namespace ({@code wot_v3_<ns>}), so a new
 *   entry never replaces the access to an older vault. Without {@code alias} only hasStoredPassphrase
 *   and deletePassphrase reach the Gen-2 entry {@code wot_biometric_key} (in the Gen-2 preferences, so
 *   an updated Gen-2 install still finds it); unlocking or storing without alias is a contract
 *   violation (INVALID_ARGUMENT), never the Gen-2 entry.
 * - a v3 entry is a file written atomically and read from disk on every call (BiometricEntries holds
 *   the contract): a fresh Keystore key per stored secret; the replaced keys go only after the disk
 *   names the new key; has and unlock only read. v3 entries are not kept in SharedPreferences: a failed
 *   commit there leaves the cache ahead of the disk.
 * - prompt texts come from the app (title, subtitle, cancel); the Gen-2 plugin hard-coded German.
 *   {@code cancel} labels the negative button below Android 11; from Android 11 the screen lock is the
 *   second way and the system shows its own button.
 * - the authenticators follow BiometricPolicy (issue #442): strong biometrics or the screen lock from
 *   Android 11 (API 30), strong biometrics only below; the same value for canAuthenticate, the prompt
 *   and the Keystore key.
 * - error codes: USER_CANCELLED, KEY_INVALIDATED (the key is permanently invalid, e.g. the screen
 *   lock was removed; the entry stays until the app removes or replaces it), KEY_NOT_FOUND (no entry
 *   or no key), AUTH_FAILED, INVALID_ARGUMENT. The Gen-2 plugin never reported KEY_INVALIDATED.
 *
 * The key is time-bound (10 s after an authentication), as in Gen 2. For such keys Android does not
 * invalidate on a newly enrolled fingerprint; it does when the secure lock screen is turned off.
 */
@CapacitorPlugin(name = "BiometricKeystore")
public class BiometricKeystorePlugin extends Plugin {

    private static final String LEGACY_ALIAS = BiometricPolicy.LEGACY_ALIAS;
    private static final String LEGACY_PREFS = "wot_biometric_prefs";
    private static final String LEGACY_PREF_CIPHERTEXT = "encrypted_passphrase";
    private static final String LEGACY_PREF_IV = "encryption_iv";
    /** v3 entries, in the no-backup files */
    private static final String ENTRY_DIR = "wot_biometric";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final int API = Build.VERSION.SDK_INT;
    private static final int AUTHENTICATORS = BiometricPolicy.authenticatorsFor(API);
    /** stores and removals of entries never interleave (plugin thread and prompt callbacks) */
    private static final Object LOCK = new Object();

    /** the entry of a call, or null after rejecting it as a contract violation */
    private static String entryOf(PluginCall call, boolean legacyAllowed) {
        String entry = BiometricPolicy.entryFor(call.getString("alias"), legacyAllowed);
        if (entry == null) call.reject("Invalid or missing alias", "INVALID_ARGUMENT");
        return entry;
    }

    private SharedPreferences legacyPrefs() {
        return getContext().getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE);
    }

    private BiometricEntries entries(String alias) {
        File dir = new File(getContext().getNoBackupFilesDir(), ENTRY_DIR);
        return new BiometricEntries(new FileDisk(new File(dir, alias + ".json")), new Keys(alias));
    }

    /** one entry file (android.util.AtomicFile), read from disk on every call */
    private static final class FileDisk implements BiometricEntries.Disk {
        private final File file;

        FileDisk(File file) {
            this.file = file;
        }

        @Override
        public BiometricEntries.Entry read() throws Exception {
            byte[] raw;
            try {
                raw = new AtomicFile(file).readFully();
            } catch (FileNotFoundException e) {
                return null;
            }
            JSONObject o = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            return new BiometricEntries.Entry(
                o.getString("key"),
                o.isNull("previousKey") ? null : o.getString("previousKey"),
                Base64.decode(o.getString("ciphertext"), Base64.NO_WRAP),
                Base64.decode(o.getString("iv"), Base64.NO_WRAP));
        }

        @Override
        public void write(BiometricEntries.Entry e) throws Exception {
            JSONObject o = new JSONObject();
            o.put("key", e.key);
            o.put("previousKey", e.previousKey == null ? JSONObject.NULL : e.previousKey);
            o.put("ciphertext", Base64.encodeToString(e.ciphertext, Base64.NO_WRAP));
            o.put("iv", Base64.encodeToString(e.iv, Base64.NO_WRAP));
            File dir = file.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("no entry folder");
            AtomicFile atomic = new AtomicFile(file);
            FileOutputStream out = atomic.startWrite();
            try {
                out.write(o.toString().getBytes(StandardCharsets.UTF_8));
            } catch (Exception ex) {
                atomic.failWrite(out);
                throw ex;
            }
            atomic.finishWrite(out);
        }

        @Override
        public void remove() {
            new AtomicFile(file).delete();
        }
    }

    private static final class Keys implements BiometricEntries.Keys {
        private final String alias;

        Keys(String alias) {
            this.alias = alias;
        }

        @Override
        public String freshName() {
            return alias + "." + UUID.randomUUID().toString().replace("-", "");
        }

        @Override
        public void create(String name) throws Exception {
            createKey(name);
        }

        @Override
        public byte[][] encrypt(String name, byte[] plain) throws Exception {
            SecretKey key = loadKey(name);
            if (key == null) throw new IllegalStateException("fresh key missing");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            return new byte[][] {cipher.doFinal(plain), cipher.getIV()};
        }

        @Override
        public void delete(String name) {
            try {
                KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
                keyStore.load(null);
                if (keyStore.containsAlias(name)) keyStore.deleteEntry(name);
            } catch (Exception ignored) {
                // a key that stays holds no secret any entry points to
            }
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int result = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        JSObject ret = new JSObject();
        ret.put("available", result == BiometricManager.BIOMETRIC_SUCCESS);
        String biometryType;
        switch (result) {
            case BiometricManager.BIOMETRIC_SUCCESS:
                // from API 30 the screen lock alone also succeeds: then no biometrics is enrolled
                biometryType = BiometricPolicy.allowsDeviceCredential(API)
                    && BiometricManager.from(getContext()).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) != BiometricManager.BIOMETRIC_SUCCESS
                    ? "credential"
                    : "available";
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
                    synchronized (LOCK) {
                        entries(alias).store(passphrase.getBytes(StandardCharsets.UTF_8));
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
        String alias = entryOf(call, false);
        if (alias == null) return;
        BiometricEntries.Entry entry;
        SecretKey key;
        try {
            entry = entries(alias).read();
            key = entry == null ? null : loadKey(entry.key);
        } catch (Exception e) {
            call.reject("Entry or Keystore unreadable: " + e.getMessage(), "AUTH_FAILED");
            return;
        }
        if (entry == null || key == null) {
            // read only: the app removes or replaces the entry (reprotect, restoreKeystore)
            call.reject("No stored entry or no key", "KEY_NOT_FOUND");
            return;
        }
        byte[] iv = entry.iv;
        byte[] ciphertext = entry.ciphertext;

        // An invalidated key is told before the prompt: Cipher.init throws
        // KeyPermanentlyInvalidatedException for it, UserNotAuthenticatedException for a valid key
        // that waits for the authentication.
        try {
            Cipher probe = Cipher.getInstance("AES/GCM/NoPadding");
            probe.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        } catch (KeyPermanentlyInvalidatedException e) {
            call.reject("Key permanently invalidated, set up again", "KEY_INVALIDATED");
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
                    call.reject("Key permanently invalidated, set up again", "KEY_INVALIDATED");
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
            boolean gone;
            synchronized (LOCK) {
                gone = LEGACY_ALIAS.equals(alias) ? removeLegacy() : entries(alias).remove();
            }
            if (!gone) {
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
        boolean stored;
        if (LEGACY_ALIAS.equals(alias)) {
            SharedPreferences p = legacyPrefs();
            stored = p.contains(LEGACY_PREF_CIPHERTEXT) && p.contains(LEGACY_PREF_IV);
        } else {
            try {
                stored = entries(alias).read() != null;
            } catch (Exception e) {
                call.reject("Entry unreadable: " + e.getMessage(), "AUTH_FAILED");
                return;
            }
        }
        JSObject ret = new JSObject();
        ret.put("stored", stored);
        call.resolve(ret);
    }

    /** the Gen-2 entry: its preferences and its fixed key; true when both are gone */
    private boolean removeLegacy() throws Exception {
        boolean written = legacyPrefs().edit().remove(LEGACY_PREF_CIPHERTEXT).remove(LEGACY_PREF_IV).commit();
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(LEGACY_ALIAS)) keyStore.deleteEntry(LEGACY_ALIAS);
        return written && !keyStore.containsAlias(LEGACY_ALIAS);
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
}
