package org.reallife.weboftrust;

/**
 * Write-then-swap for a biometric entry (pure; EntryReplacementTest). A new secret goes under a fresh
 * Keystore key; the stored entry names its key and is replaced in one commit only after the new key
 * encrypted the secret. Until then the old entry and its key stay usable; a failure removes only the
 * fresh key. The old key goes after the commit.
 */
final class EntryReplacement {
    interface Steps {
        /** the Keystore key of the current entry, null when there is none */
        String currentKey();

        /** a key name no entry uses */
        String freshKeyName();

        void createKey(String keyName) throws Exception;

        /** {ciphertext, iv} */
        byte[][] encrypt(String keyName, byte[] plain) throws Exception;

        /** writes ciphertext, iv and the key name of the entry at once; false when not written */
        boolean commit(String keyName, byte[] ciphertext, byte[] iv);

        /** never throws */
        void deleteKey(String keyName);
    }

    private EntryReplacement() {}

    static void replace(Steps steps, byte[] plain) throws Exception {
        String old = steps.currentKey();
        String next = steps.freshKeyName();
        if (next == null || next.equals(old)) throw new IllegalStateException("no fresh key name");
        try {
            steps.createKey(next);
            byte[][] sealed = steps.encrypt(next, plain);
            if (!steps.commit(next, sealed[0], sealed[1])) throw new IllegalStateException("entry not written");
        } catch (Exception e) {
            steps.deleteKey(next);
            throw e;
        }
        if (old != null) steps.deleteKey(old);
    }
}
