package org.reallife.weboftrust;

import android.content.SharedPreferences;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.util.AtomicFile;
import android.util.Base64;

import org.json.JSONObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The storage of the biometric entries: entry files, their Keystore keys and the Gen-2 entry, behind one
 * lock. BiometricKeystorePlugin only calls has, checkUnlock, unlock, store and remove; it decides
 * nothing about locks or removals.
 *
 * Contract:
 * - After a failure or a process abort, either the old or the new confirmed entry stays decryptable.
 * - When the state is unclear, no key that may still be needed is removed.
 * - Reading never changes anything.
 *
 * How it holds:
 * - Every access to an entry file, reading included, runs under one lock for the whole process
 *   (android.util.AtomicFile needs that: its read rolls back a write in progress, issue #444), and
 *   reading the entry and checking its key happen together under it.
 * - A v3 entry ({@code wot_v3_<ns>}) is one file, written atomically and read from disk on every call
 *   (no cache that a failed write leaves ahead of the disk). It names its key and the key it replaced.
 * - store: a fresh key encrypts the secret, the entry is written, and the disk decides: it names the
 *   fresh key → the replaced keys go; it still holds the old entry → only the fresh key goes; it cannot
 *   be read → no key goes.
 * - remove: the entry goes, then every key it named.
 * - The Gen-2 entry {@code wot_biometric_key} (SharedPreferences of apps/demo and its fixed key) is
 *   only found and removed.
 */
final class BiometricStore {

    /** a failure with the plugin's error code */
    static final class Failure extends Exception {
        final String code;

        Failure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** the Keystore as the store uses it; AndroidKeyVault on a device, an in-memory one in tests */
    interface KeyVault {
        void create(String name) throws Exception;

        boolean exists(String name) throws Exception;

        /** {ciphertext, iv} */
        byte[][] encrypt(String name, byte[] plain) throws Exception;

        /** throws KeyPermanentlyInvalidatedException for a key that can never be used again */
        void probe(String name, byte[] iv) throws Exception;

        byte[] decrypt(String name, byte[] iv, byte[] ciphertext) throws Exception;

        /** never throws; a missing key is no error */
        void delete(String name);
    }

    /** test seam: runs between writing the new entry's bytes and finishing the atomic write */
    interface WriteHook {
        void beforeFinish() throws Exception;
    }

    static final String LEGACY_ALIAS = BiometricPolicy.LEGACY_ALIAS;
    static final String LEGACY_PREF_CIPHERTEXT = "encrypted_passphrase";
    static final String LEGACY_PREF_IV = "encryption_iv";

    /** one serializer for every entry of the process */
    private static final ReentrantLock LOCK = new ReentrantLock();

    private final File dir;
    private final KeyVault vault;
    private final SharedPreferences legacy;
    WriteHook writeHook = () -> { };

    BiometricStore(File dir, KeyVault vault, SharedPreferences legacy) {
        this.dir = dir;
        this.vault = vault;
        this.legacy = legacy;
    }

    private static final class Entry {
        final String key;
        final String previousKey;
        final byte[] ciphertext;
        final byte[] iv;

        Entry(String key, String previousKey, byte[] ciphertext, byte[] iv) {
            this.key = key;
            this.previousKey = previousKey;
            this.ciphertext = ciphertext;
            this.iv = iv;
        }
    }

    boolean has(String alias) throws Exception {
        LOCK.lock();
        try {
            if (LEGACY_ALIAS.equals(alias)) return legacy.contains(LEGACY_PREF_CIPHERTEXT) && legacy.contains(LEGACY_PREF_IV);
            return read(alias) != null;
        } finally {
            LOCK.unlock();
        }
    }

    /** before the prompt: the entry and its key exist and the key is not invalidated; changes nothing */
    void checkUnlock(String alias) throws Failure {
        LOCK.lock();
        try {
            Entry e = readForUnlock(alias);
            try {
                vault.probe(e.key, e.iv);
            } catch (KeyPermanentlyInvalidatedException ex) {
                throw new Failure("KEY_INVALIDATED", "Key permanently invalidated, set up again");
            } catch (Exception ex) {
                // anything else shows again after the prompt
            }
        } finally {
            LOCK.unlock();
        }
    }

    /** after the prompt: the secret of the entry on disk; changes nothing */
    byte[] unlock(String alias) throws Failure {
        LOCK.lock();
        try {
            Entry e = readForUnlock(alias);
            try {
                return vault.decrypt(e.key, e.iv, e.ciphertext);
            } catch (KeyPermanentlyInvalidatedException ex) {
                throw new Failure("KEY_INVALIDATED", "Key permanently invalidated, set up again");
            } catch (Exception ex) {
                throw new Failure("AUTH_FAILED", "Decryption failed: " + ex.getMessage());
            }
        } finally {
            LOCK.unlock();
        }
    }

    private Entry readForUnlock(String alias) throws Failure {
        Entry e;
        boolean key;
        try {
            e = read(alias);
            key = e != null && vault.exists(e.key);
        } catch (Exception ex) {
            throw new Failure("AUTH_FAILED", "Entry or Keystore unreadable: " + ex.getMessage());
        }
        // the entry stays: the app removes or replaces it (reprotect, restoreKeystore)
        if (!key) throw new Failure("KEY_NOT_FOUND", "No stored entry or no key");
        return e;
    }

    void store(String alias, byte[] plain) throws Exception {
        LOCK.lock();
        try {
            Entry old = read(alias);
            String next = alias + "." + UUID.randomUUID().toString().replace("-", "");
            byte[][] sealed;
            try {
                vault.create(next);
                sealed = vault.encrypt(next, plain);
            } catch (Exception e) {
                vault.delete(next);
                throw e;
            }
            Exception failure = null;
            try {
                write(alias, new Entry(next, old == null ? null : old.key, sealed[0], sealed[1]));
            } catch (Exception e) {
                failure = e;
            }
            Entry now;
            try {
                now = read(alias);
            } catch (Exception e) {
                // unclear: no key may go
                throw failure != null ? failure : e;
            }
            if (now != null && next.equals(now.key)) {
                if (old != null) {
                    vault.delete(old.key);
                    if (old.previousKey != null) vault.delete(old.previousKey);
                }
                return;
            }
            if (now == null ? old == null : old != null && old.key.equals(now.key)) {
                // the disk holds what it held: the fresh key is named nowhere
                vault.delete(next);
            }
            throw failure != null ? failure : new IllegalStateException("entry not written");
        } finally {
            LOCK.unlock();
        }
    }

    /** true when the entry is gone; the keys it named go with it */
    boolean remove(String alias) throws Exception {
        LOCK.lock();
        try {
            if (LEGACY_ALIAS.equals(alias)) {
                boolean written = legacy.edit().remove(LEGACY_PREF_CIPHERTEXT).remove(LEGACY_PREF_IV).commit();
                vault.delete(LEGACY_ALIAS);
                return written && !vault.exists(LEGACY_ALIAS);
            }
            Entry old = read(alias);
            file(alias).delete();
            if (read(alias) != null) return false;
            if (old != null) {
                vault.delete(old.key);
                if (old.previousKey != null) vault.delete(old.previousKey);
            }
            return true;
        } finally {
            LOCK.unlock();
        }
    }

    private AtomicFile file(String alias) {
        return new AtomicFile(new File(dir, alias + ".json"));
    }

    /** under LOCK only */
    private Entry read(String alias) throws Exception {
        byte[] raw;
        try {
            raw = file(alias).readFully();
        } catch (FileNotFoundException e) {
            return null;
        }
        JSONObject o = new JSONObject(new String(raw, StandardCharsets.UTF_8));
        return new Entry(
            o.getString("key"),
            o.isNull("previousKey") ? null : o.getString("previousKey"),
            Base64.decode(o.getString("ciphertext"), Base64.NO_WRAP),
            Base64.decode(o.getString("iv"), Base64.NO_WRAP));
    }

    /** under LOCK only */
    private void write(String alias, Entry e) throws Exception {
        JSONObject o = new JSONObject();
        o.put("key", e.key);
        o.put("previousKey", e.previousKey == null ? JSONObject.NULL : e.previousKey);
        o.put("ciphertext", Base64.encodeToString(e.ciphertext, Base64.NO_WRAP));
        o.put("iv", Base64.encodeToString(e.iv, Base64.NO_WRAP));
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("no entry folder");
        AtomicFile atomic = file(alias);
        FileOutputStream out = atomic.startWrite();
        try {
            out.write(o.toString().getBytes(StandardCharsets.UTF_8));
            writeHook.beforeFinish();
        } catch (Exception ex) {
            atomic.failWrite(out);
            throw ex;
        }
        atomic.finishWrite(out);
    }
}
