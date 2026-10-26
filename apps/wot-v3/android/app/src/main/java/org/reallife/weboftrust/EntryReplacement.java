package org.reallife.weboftrust;

/**
 * Write-then-swap for a biometric entry (pure; EntryReplacementTest). A new secret goes under a fresh
 * Keystore key; the stored entry names its key and is replaced in one commit only after the new key
 * encrypted the secret. Until then the old entry and its key stay usable; a failure before the commit
 * removes only the fresh key, a failed commit removes no key. The old key goes after the commit.
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

    /**
     * The Keystore keys of one v3 entry that no entry names (a process ended between commit and the
     * removal of the old key, a failed removal, a failed commit, or the key of a pre-release build
     * named like the entry itself): every key {@code alias} or {@code alias.*} except {@code current}.
     */
    static java.util.List<String> orphansOf(Iterable<String> keystoreAliases, String alias, String current) {
        java.util.List<String> out = new java.util.ArrayList<>();
        for (String k : keystoreAliases) {
            if (k.equals(current)) continue;
            if (k.equals(alias) || k.startsWith(alias + ".")) out.add(k);
        }
        return out;
    }

    static void replace(Steps steps, byte[] plain) throws Exception {
        String old = steps.currentKey();
        String next = steps.freshKeyName();
        if (next == null || next.equals(old)) throw new IllegalStateException("no fresh key name");
        byte[][] sealed;
        try {
            steps.createKey(next);
            sealed = steps.encrypt(next, plain);
        } catch (Exception e) {
            steps.deleteKey(next);
            throw e;
        }
        // A failed commit may already have changed the entry in memory (SharedPreferences takes the
        // values before it writes them): both keys stay, so the entry in memory and the one on disk
        // each still find their key. A key no entry names is collected later (orphansOf).
        if (!steps.commit(next, sealed[0], sealed[1])) throw new IllegalStateException("entry not written");
        if (old != null) steps.deleteKey(old);
    }
}
