package org.reallife.weboftrust;

import android.content.Context;
import android.os.Build;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.nio.charset.StandardCharsets;

/**
 * A secret behind the device's biometrics or screen lock (src/platform/capacitor/biometric.ts).
 *
 * Taken from apps/demo and brought to the v3 interface:
 * - every call takes an {@code alias}: one entry per identity namespace ({@code wot_v3_<ns>}), so a new
 *   entry never replaces the access to an older vault. Without {@code alias} only hasStoredPassphrase
 *   and deletePassphrase reach the Gen-2 entry {@code wot_biometric_key}; unlocking or storing without
 *   alias is a contract violation (INVALID_ARGUMENT), never the Gen-2 entry.
 * - storage, locking and every removal belong to BiometricStore (its contract: after a failure or a
 *   process abort the old or the new confirmed entry stays decryptable; when the state is unclear no
 *   key that may still be needed is removed; reading never changes anything). This class prompts and
 *   maps the results to error codes.
 * - prompt texts come from the app (title, subtitle, cancel); the Gen-2 plugin hard-coded German.
 *   {@code cancel} labels the negative button below Android 11; from Android 11 the screen lock is the
 *   second way and the system shows its own button.
 * - the authenticators follow BiometricPolicy (issue #442): strong biometrics or the screen lock from
 *   Android 11 (API 30), strong biometrics only below; the same value for canAuthenticate, the prompt
 *   and the Keystore key (AndroidKeyVault).
 * - error codes: USER_CANCELLED, KEY_INVALIDATED (the key is permanently invalid, e.g. the screen
 *   lock was removed; the entry stays until the app removes or replaces it), KEY_NOT_FOUND (no entry
 *   or no key), AUTH_FAILED, INVALID_ARGUMENT. The Gen-2 plugin never reported KEY_INVALIDATED.
 *
 * The key is time-bound (10 s after an authentication), as in Gen 2. For such keys Android does not
 * invalidate on a newly enrolled fingerprint; it does when the secure lock screen is turned off.
 */
@CapacitorPlugin(name = "BiometricKeystore")
public class BiometricKeystorePlugin extends Plugin {

    private static final String LEGACY_PREFS = "wot_biometric_prefs";
    /** v3 entries, in the no-backup files */
    private static final String ENTRY_DIR = "wot_biometric";
    private static final int API = Build.VERSION.SDK_INT;
    private static final int AUTHENTICATORS = BiometricPolicy.authenticatorsFor(API);

    private BiometricStore store;

    @Override
    public void load() {
        Context context = getContext();
        store = new BiometricStore(
            new File(context.getNoBackupFilesDir(), ENTRY_DIR),
            new AndroidKeyVault(),
            context.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE));
    }

    /** the entry of a call, or null after rejecting it as a contract violation */
    private static String entryOf(PluginCall call, boolean legacyAllowed) {
        String entry = BiometricPolicy.entryFor(call.getString("alias"), legacyAllowed);
        if (entry == null) call.reject("Invalid or missing alias", "INVALID_ARGUMENT");
        return entry;
    }

    private static void reject(PluginCall call, Exception e) {
        if (e instanceof BiometricStore.Failure) call.reject(e.getMessage(), ((BiometricStore.Failure) e).code);
        else call.reject(e.getMessage(), "AUTH_FAILED");
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
                    store.store(alias, passphrase.getBytes(StandardCharsets.UTF_8));
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
        try {
            store.checkUnlock(alias);
        } catch (BiometricStore.Failure e) {
            reject(call, e);
            return;
        }
        prompt(call, "Unlock your identity", new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                try {
                    JSObject ret = new JSObject();
                    ret.put("passphrase", new String(store.unlock(alias), StandardCharsets.UTF_8));
                    call.resolve(ret);
                } catch (BiometricStore.Failure e) {
                    reject(call, e);
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
            if (!store.remove(alias)) {
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
        try {
            JSObject ret = new JSObject();
            ret.put("stored", store.has(alias));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Entry unreadable: " + e.getMessage(), "AUTH_FAILED");
        }
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
}
