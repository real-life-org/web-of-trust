package org.reallife.weboftrust;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;

import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** BiometricStore.KeyVault on the AndroidKeyStore: AES-GCM keys bound to the authenticators of BiometricPolicy. */
final class AndroidKeyVault implements BiometricStore.KeyVault {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final int API = Build.VERSION.SDK_INT;

    private static KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        return ks;
    }

    private static SecretKey key(String name) throws Exception {
        KeyStore ks = keyStore();
        if (!ks.containsAlias(name)) throw new IllegalStateException("no key " + name);
        return (SecretKey) ks.getKey(name, null);
    }

    @Override
    public void create(String name) throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
            name,
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
        generator.init(spec.build());
        generator.generateKey();
    }

    @Override
    public boolean exists(String name) throws Exception {
        return keyStore().containsAlias(name);
    }

    @Override
    public byte[][] encrypt(String name, byte[] plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(name));
        return new byte[][] {cipher.doFinal(plain), cipher.getIV()};
    }

    @Override
    public void probe(String name, byte[] iv) throws Exception {
        // Cipher.init tells an invalidated key (KeyPermanentlyInvalidatedException) from a valid one that
        // waits for the authentication (UserNotAuthenticatedException)
        try {
            Cipher.getInstance("AES/GCM/NoPadding").init(Cipher.DECRYPT_MODE, key(name), new GCMParameterSpec(128, iv));
        } catch (UserNotAuthenticatedException expected) {
            // the prompt follows
        } catch (KeyPermanentlyInvalidatedException e) {
            throw e;
        }
    }

    @Override
    public byte[] decrypt(String name, byte[] iv, byte[] ciphertext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(name), new GCMParameterSpec(128, iv));
        return cipher.doFinal(ciphertext);
    }

    @Override
    public void delete(String name) {
        try {
            KeyStore ks = keyStore();
            if (ks.containsAlias(name)) ks.deleteEntry(name);
        } catch (Exception ignored) {
            // a key that stays holds no secret any entry points to
        }
    }
}
