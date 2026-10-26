package org.reallife.weboftrust;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.Test;

/** Write-then-swap of a biometric entry (review 441-1 Minor 2): a failed store keeps the old entry. */
public class EntryReplacementTest {

    /** a keystore and one stored entry in memory; fails at a chosen step */
    static final class Fake implements EntryReplacement.Steps {
        final Map<String, byte[]> keys = new HashMap<>();
        String entryKey;
        byte[] entryCiphertext;
        /** what a restarted process reads: SharedPreferences writes memory first, then the disk */
        String diskKey;
        byte[] diskCiphertext;
        final List<String> log = new ArrayList<>();
        String failAt = "";
        int fresh = 0;

        @Override public String currentKey() { return entryKey; }

        @Override public String freshKeyName() { return "wot_v3_n01." + (++fresh); }

        @Override public void createKey(String keyName) throws Exception {
            log.add("create " + keyName);
            if (failAt.equals("create")) throw new Exception("keystore full");
            keys.put(keyName, new byte[] {(byte) fresh});
        }

        @Override public byte[][] encrypt(String keyName, byte[] plain) throws Exception {
            log.add("encrypt " + keyName);
            if (failAt.equals("encrypt")) throw new Exception("user not authenticated");
            byte[] out = plain.clone();
            for (int i = 0; i < out.length; i++) out[i] ^= keys.get(keyName)[0];
            return new byte[][] {out, new byte[] {1}};
        }

        @Override public boolean commit(String keyName, byte[] ciphertext, byte[] iv) {
            log.add("commit " + keyName);
            // SharedPreferencesImpl.commit: commitToMemory, then the write to disk
            entryKey = keyName;
            entryCiphertext = ciphertext;
            if (failAt.equals("commit")) return false;
            diskKey = keyName;
            diskCiphertext = ciphertext;
            return true;
        }

        @Override public void deleteKey(String keyName) {
            log.add("delete " + keyName);
            keys.remove(keyName);
        }

        byte[] read() {
            return open(entryKey, entryCiphertext);
        }

        byte[] readDisk() {
            return open(diskKey, diskCiphertext);
        }

        private byte[] open(String key, byte[] ciphertext) {
            byte[] k = keys.get(key);
            if (k == null) throw new IllegalStateException("the entry names a key that is gone: " + key);
            byte[] out = ciphertext.clone();
            for (int i = 0; i < out.length; i++) out[i] ^= k[0];
            return out;
        }
    }

    private static final byte[] OLD = {10, 20, 30};
    private static final byte[] NEW = {40, 50, 60};

    private static Fake withOldEntry() throws Exception {
        Fake f = new Fake();
        EntryReplacement.replace(f, OLD);
        f.log.clear();
        return f;
    }

    @Test
    public void successSwapsToTheNewKeyAndRemovesTheOldOneAfterTheCommit() throws Exception {
        Fake f = withOldEntry();
        EntryReplacement.replace(f, NEW);
        assertEquals(List.of("create wot_v3_n01.2", "encrypt wot_v3_n01.2", "commit wot_v3_n01.2", "delete wot_v3_n01.1"), f.log);
        assertArrayEquals(NEW, f.read());
        assertEquals(1, f.keys.size());
    }

    @Test
    public void aFailedCommitRemovesNoKey() throws Exception {
        // review 441-2 N1: the entry in memory already names the fresh key, the one on disk the old key
        Fake f = withOldEntry();
        f.failAt = "commit";
        try {
            EntryReplacement.replace(f, NEW);
            fail("expected a failure");
        } catch (IllegalStateException expected) {
            // reported to the app as AUTH_FAILED
        }
        assertEquals(List.of("create wot_v3_n01.2", "encrypt wot_v3_n01.2", "commit wot_v3_n01.2"), f.log);
        assertArrayEquals("this process", NEW, f.read());
        assertArrayEquals("after a restart", OLD, f.readDisk());
        assertEquals(2, f.keys.size());
    }

    @Test
    public void orphansAreTheKeysOfTheEntryNoEntryNames() {
        List<String> keystore = List.of("wot_v3_n01", "wot_v3_n01.a", "wot_v3_n01.b", "wot_v3_n012.c", "wot_v3_n02.d", "wot_biometric_key");
        assertEquals(List.of("wot_v3_n01", "wot_v3_n01.a"), EntryReplacement.orphansOf(keystore, "wot_v3_n01", "wot_v3_n01.b"));
        // no entry: every key of it
        assertEquals(List.of("wot_v3_n01", "wot_v3_n01.a", "wot_v3_n01.b"), EntryReplacement.orphansOf(keystore, "wot_v3_n01", null));
        // another namespace with a longer name and the Gen-2 key are never touched
        assertEquals(List.of(), EntryReplacement.orphansOf(List.of("wot_v3_n012.c", "wot_biometric_key"), "wot_v3_n01", null));
    }

    @Test
    public void aFailureBeforeTheCommitKeepsTheOldEntryReadable() throws Exception {
        for (String step : new String[] {"create", "encrypt"}) {
            Fake f = withOldEntry();
            f.failAt = step;
            try {
                EntryReplacement.replace(f, NEW);
                fail(step + ": expected a failure");
            } catch (Exception expected) {
                // reported to the app as AUTH_FAILED
            }
            assertEquals(step, "wot_v3_n01.1", f.entryKey);
            assertArrayEquals(step, OLD, f.read());
            assertArrayEquals(step, OLD, f.readDisk());
            assertEquals(step + ": only the old key remains", 1, f.keys.size());
            assertEquals(step, "delete wot_v3_n01.2", f.log.get(f.log.size() - 1));
        }
    }

    @Test
    public void aFirstEntryHasNoOldKeyToRemove() throws Exception {
        Fake f = new Fake();
        assertNull(f.currentKey());
        EntryReplacement.replace(f, NEW);
        assertEquals(List.of("create wot_v3_n01.1", "encrypt wot_v3_n01.1", "commit wot_v3_n01.1"), f.log);
        assertArrayEquals(NEW, f.read());
    }
}
