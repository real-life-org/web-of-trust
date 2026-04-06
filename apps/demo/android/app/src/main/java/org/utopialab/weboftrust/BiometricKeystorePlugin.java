package org.utopialab.weboftrust;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.content.SharedPreferences;
import android.content.Context;
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

import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "BiometricKeystore")
public class BiometricKeystorePlugin extends Plugin {

    private static final String KEYSTORE_ALIAS = "wot_biometric_key";
    private static final String PREFS_NAME = "wot_biometric_prefs";
    private static final String PREF_CIPHERTEXT = "encrypted_passphrase";
    private static final String PREF_IV = "encryption_iv";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";

    @PluginMethod
    public void isAvailable(PluginCall call) {
        BiometricManager biometricManager = BiometricManager.from(getContext());
        int result = biometricManager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG |
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        );

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
            call.reject("Passphrase is required");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                FragmentActivity activity = getActivity();
                BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Biometrie einrichten")
                    .setSubtitle("Bestätige deine Identität")
                    .setAllowedAuthenticators(
                        BiometricManager.Authenticators.BIOMETRIC_STRONG |
                        BiometricManager.Authenticators.DEVICE_CREDENTIAL
                    )
                    .build();

                BiometricPrompt biometricPrompt = new BiometricPrompt(activity,
                    ContextCompat.getMainExecutor(getContext()),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            try {
                                SecretKey key = createKey();
                                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                                cipher.init(Cipher.ENCRYPT_MODE, key);

                                byte[] ciphertext = cipher.doFinal(passphrase.getBytes("UTF-8"));
                                byte[] iv = cipher.getIV();

                                SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                                prefs.edit()
                                    .putString(PREF_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                                    .putString(PREF_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                                    .apply();

                                call.resolve();
                            } catch (Exception e) {
                                call.reject("Failed to store passphrase: " + e.getMessage());
                            }
                        }

                        @Override
                        public void onAuthenticationError(int errorCode, CharSequence errString) {
                            call.reject("Authentication cancelled", "USER_CANCELLED");
                        }

                        @Override
                        public void onAuthenticationFailed() {}
                    }
                );

                biometricPrompt.authenticate(promptInfo);
            } catch (Exception e) {
                call.reject("Failed to store passphrase: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void unlockPassphrase(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String ciphertextB64 = prefs.getString(PREF_CIPHERTEXT, null);
        String ivB64 = prefs.getString(PREF_IV, null);

        if (ciphertextB64 == null || ivB64 == null) {
            call.reject("No stored passphrase found");
            return;
        }

        try {
            SecretKey key = loadKey();
            if (key == null) {
                deleteStoredData();
                call.reject("Biometric key not found — re-enrollment required", "KEY_NOT_FOUND");
                return;
            }

            byte[] iv = Base64.decode(ivB64, Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(ciphertextB64, Base64.NO_WRAP);

            getActivity().runOnUiThread(() -> {
                try {
                    FragmentActivity activity = getActivity();
                    BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle("Identität entsperren")
                        .setSubtitle("Bestätige deine Identität")
                        .setAllowedAuthenticators(
                            BiometricManager.Authenticators.BIOMETRIC_STRONG |
                            BiometricManager.Authenticators.DEVICE_CREDENTIAL
                        )
                        .build();

                    BiometricPrompt biometricPrompt = new BiometricPrompt(activity,
                        ContextCompat.getMainExecutor(getContext()),
                        new BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                                try {
                                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                                    cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
                                    byte[] plaintext = cipher.doFinal(ciphertext);
                                    JSObject ret = new JSObject();
                                    ret.put("passphrase", new String(plaintext, "UTF-8"));
                                    call.resolve(ret);
                                } catch (Exception e) {
                                    call.reject("Decryption failed: " + e.getMessage());
                                }
                            }

                            @Override
                            public void onAuthenticationError(int errorCode, CharSequence errString) {
                                if (errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                                    errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                                    errorCode == BiometricPrompt.ERROR_CANCELED) {
                                    call.reject("User cancelled", "USER_CANCELLED");
                                } else {
                                    call.reject("Authentication failed: " + errString, "AUTH_FAILED");
                                }
                            }

                            @Override
                            public void onAuthenticationFailed() {}
                        }
                    );

                    biometricPrompt.authenticate(promptInfo);
                } catch (Exception e) {
                    call.reject("Unlock failed: " + e.getMessage());
                }
            });

        } catch (KeyPermanentlyInvalidatedException e) {
            deleteStoredData();
            call.reject("Biometric data changed — re-enrollment required", "KEY_INVALIDATED");
        } catch (Exception e) {
            call.reject("Unlock failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void deletePassphrase(PluginCall call) {
        try {
            deleteStoredData();
            KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
            keyStore.load(null);
            if (keyStore.containsAlias(KEYSTORE_ALIAS)) {
                keyStore.deleteEntry(KEYSTORE_ALIAS);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to delete: " + e.getMessage());
        }
    }

    @PluginMethod
    public void hasStoredPassphrase(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        boolean stored = prefs.contains(PREF_CIPHERTEXT) && prefs.contains(PREF_IV);
        JSObject ret = new JSObject();
        ret.put("stored", stored);
        call.resolve(ret);
    }

    private SecretKey createKey() throws Exception {
        KeyGenerator keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE
        );

        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
            KEYSTORE_ALIAS,
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

    private SecretKey loadKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (!keyStore.containsAlias(KEYSTORE_ALIAS)) {
            return null;
        }
        return (SecretKey) keyStore.getKey(KEYSTORE_ALIAS, null);
    }

    private void deleteStoredData() {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().remove(PREF_CIPHERTEXT).remove(PREF_IV).apply();
    }
}
