package org.reallife.weboftrust;

/**
 * One v3 biometric entry and its Keystore keys (pure; BiometricEntriesTest). The contract:
 *
 * - The entry lives on disk only (Disk: one file per entry, written atomically, read from disk on every
 *   call; no cache that a failed write could leave ahead of the disk). It names its key and the key it
 *   replaced.
 * - store: a fresh key encrypts the secret, then the entry is written. Whether the write took is read
 *   back from disk: the disk names the fresh key → the replaced keys go (the previous key of the old
 *   entry and the one it had replaced); the disk still names the old entry → only the fresh key goes;
 *   the disk cannot be read → no key goes. Keys are removed nowhere else on a store.
 * - read (has, unlock): reads only, never removes a key or an entry.
 * - remove: the entry file goes, then every key the entry on disk named (its key and the replaced one).
 *
 * A key that no entry names can stay behind (a process ended between the write and the removal of the
 * old key): it holds no secret any entry points to, the next store or remove of the entry takes it
 * along through {@code previousKey}.
 */
final class BiometricEntries {

    static final class Entry {
        final String key;
        /** the key this entry replaced; removed after the write, kept here in case that removal failed */
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

    interface Disk {
        /** the entry on disk, null when there is none; throws when it cannot be read */
        Entry read() throws Exception;

        /** writes the whole entry atomically (the old one stays when the write fails) */
        void write(Entry entry) throws Exception;

        void remove() throws Exception;
    }

    interface Keys {
        /** a key name no entry uses */
        String freshName();

        void create(String name) throws Exception;

        /** {ciphertext, iv} */
        byte[][] encrypt(String name, byte[] plain) throws Exception;

        /** never throws; a missing key is no error */
        void delete(String name);
    }

    private final Disk disk;
    private final Keys keys;

    BiometricEntries(Disk disk, Keys keys) {
        this.disk = disk;
        this.keys = keys;
    }

    Entry read() throws Exception {
        return disk.read();
    }

    void store(byte[] plain) throws Exception {
        Entry old = disk.read();
        String next = keys.freshName();
        if (next == null || (old != null && (next.equals(old.key) || next.equals(old.previousKey)))) {
            throw new IllegalStateException("no fresh key name");
        }
        byte[][] sealed;
        try {
            keys.create(next);
            sealed = keys.encrypt(next, plain);
        } catch (Exception e) {
            keys.delete(next);
            throw e;
        }
        Exception failure = null;
        try {
            disk.write(new Entry(next, old == null ? null : old.key, sealed[0], sealed[1]));
        } catch (Exception e) {
            failure = e;
        }
        Entry now;
        try {
            now = disk.read();
        } catch (Exception e) {
            // the disk state is unknown: no key may go
            throw failure != null ? failure : e;
        }
        if (now != null && next.equals(now.key)) {
            if (old != null) {
                keys.delete(old.key);
                if (old.previousKey != null) keys.delete(old.previousKey);
            }
            return;
        }
        if (now == null ? old == null : old != null && old.key.equals(now.key)) {
            // the disk still holds what it held: the fresh key is named nowhere
            keys.delete(next);
        }
        throw failure != null ? failure : new IllegalStateException("entry not written");
    }

    /** true when the entry is gone from disk; the keys it named go with it */
    boolean remove() throws Exception {
        Entry old = disk.read();
        disk.remove();
        if (disk.read() != null) return false;
        if (old != null) {
            keys.delete(old.key);
            if (old.previousKey != null) keys.delete(old.previousKey);
        }
        return true;
    }
}
