package org.reallife.weboftrust;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.Test;

/** The entry contract of BiometricEntries (reviews 441-1 Minor 2, 441-2 N1, Loop-Review 441-2). */
public class BiometricEntriesTest {

    /** what survives a restart: the file on disk and the Keystore */
    static final class Device {
        BiometricEntries.Entry file;
        final Map<String, Byte> keystore = new HashMap<>();
        final List<String> log = new ArrayList<>();
        /** "write": the write fails and the old file stays; "write-lost": write reports success, file unchanged;
         *  "write-throws-after": the file is replaced, then the write throws; "read-after": reading fails after a write */
        String fail = "";
        boolean written = false;
        int fresh = 0;
    }

    /** one process: reads the disk on every call, as the plugin does */
    static BiometricEntries process(Device d) {
        BiometricEntries.Disk disk = new BiometricEntries.Disk() {
            @Override public BiometricEntries.Entry read() throws Exception {
                if (d.fail.equals("read-after") && d.written) throw new Exception("disk unreadable");
                return d.file;
            }

            @Override public void write(BiometricEntries.Entry e) throws Exception {
                d.log.add("write " + e.key);
                d.written = true;
                if (d.fail.equals("write")) throw new Exception("no space left");
                if (d.fail.equals("write-lost")) return;
                d.file = e;
                if (d.fail.equals("write-throws-after")) throw new Exception("close failed");
            }

            @Override public void remove() {
                d.log.add("remove");
                d.file = null;
            }
        };
        BiometricEntries.Keys keys = new BiometricEntries.Keys() {
            @Override public String freshName() { return "wot_v3_n01." + (++d.fresh); }

            @Override public void create(String name) throws Exception {
                d.log.add("create " + name);
                if (d.fail.equals("create")) throw new Exception("keystore full");
                d.keystore.put(name, (byte) d.fresh);
            }

            @Override public byte[][] encrypt(String name, byte[] plain) throws Exception {
                d.log.add("encrypt " + name);
                if (d.fail.equals("encrypt")) throw new Exception("user not authenticated");
                return new byte[][] {xor(plain, d.keystore.get(name)), new byte[] {1}};
            }

            @Override public void delete(String name) {
                d.log.add("delete " + name);
                d.keystore.remove(name);
            }
        };
        return new BiometricEntries(disk, keys);
    }

    static byte[] xor(byte[] in, byte k) {
        byte[] out = in.clone();
        for (int i = 0; i < out.length; i++) out[i] ^= k;
        return out;
    }

    /** unlock as the plugin does it: read the entry from disk, decrypt with the key it names */
    static byte[] unlock(Device d) throws Exception {
        BiometricEntries.Entry e = process(d).read();
        if (e == null) throw new IllegalStateException("KEY_NOT_FOUND: no entry");
        Byte k = d.keystore.get(e.key);
        if (k == null) throw new IllegalStateException("KEY_NOT_FOUND: the entry names a key that is gone: " + e.key);
        return xor(e.ciphertext, k);
    }

    private static final byte[] OLD = {10, 20, 30};
    private static final byte[] NEW = {40, 50, 60};

    private static Device withOldEntry() throws Exception {
        Device d = new Device();
        process(d).store(OLD);
        d.log.clear();
        d.written = false;
        return d;
    }

    @Test
    public void theLoopReviewSequence_failedWriteThenHasAndUnlockThenRestart() throws Exception {
        Device d = withOldEntry();
        d.fail = "write";
        try {
            process(d).store(NEW);
            fail("expected the store to fail");
        } catch (Exception expected) {
            // AUTH_FAILED to the app
        }
        d.fail = "";
        // has and unlock in the same process
        assertTrue(process(d).read() != null);
        assertArrayEquals(OLD, unlock(d));
        // restart: a new process reads the disk
        assertArrayEquals(OLD, unlock(d));
        assertEquals("only the old key remains", List.of("wot_v3_n01.1"), new ArrayList<>(d.keystore.keySet()));
    }

    @Test
    public void successReplacesTheEntryThenRemovesTheOldKey() throws Exception {
        Device d = withOldEntry();
        process(d).store(NEW);
        assertEquals(List.of("create wot_v3_n01.2", "encrypt wot_v3_n01.2", "write wot_v3_n01.2", "delete wot_v3_n01.1"), d.log);
        assertArrayEquals(NEW, unlock(d));
        assertEquals("wot_v3_n01.1", d.file.previousKey);
        assertEquals(List.of("wot_v3_n01.2"), new ArrayList<>(d.keystore.keySet()));
    }

    @Test
    public void aFailureBeforeTheWriteRemovesOnlyTheFreshKey() throws Exception {
        for (String step : new String[] {"create", "encrypt", "write"}) {
            Device d = withOldEntry();
            d.fail = step;
            try {
                process(d).store(NEW);
                fail(step + ": expected a failure");
            } catch (Exception expected) {
                // AUTH_FAILED
            }
            d.fail = "";
            assertArrayEquals(step, OLD, unlock(d));
            assertEquals(step, List.of("wot_v3_n01.1"), new ArrayList<>(d.keystore.keySet()));
        }
    }

    @Test
    public void aWriteThatReportsSuccessButDidNotTakeIsJudgedByTheDisk() throws Exception {
        Device d = withOldEntry();
        d.fail = "write-lost";
        try {
            process(d).store(NEW);
            fail("expected a failure");
        } catch (IllegalStateException expected) {
            // the disk does not name the fresh key
        }
        d.fail = "";
        assertArrayEquals(OLD, unlock(d));
        assertFalse(d.keystore.containsKey("wot_v3_n01.2"));
    }

    @Test
    public void aWriteThatTookButThrewCountsAsWritten() throws Exception {
        Device d = withOldEntry();
        d.fail = "write-throws-after";
        process(d).store(NEW);
        d.fail = "";
        assertArrayEquals(NEW, unlock(d));
        assertFalse(d.keystore.containsKey("wot_v3_n01.1"));
    }

    @Test
    public void anUnreadableDiskAfterTheWriteRemovesNoKey() throws Exception {
        Device d = withOldEntry();
        d.fail = "read-after";
        try {
            process(d).store(NEW);
            fail("expected a failure");
        } catch (Exception expected) {
            // state unknown
        }
        assertEquals(2, d.keystore.size());
        d.fail = "";
        assertArrayEquals(NEW, unlock(d));
    }

    @Test
    public void readingNeverRemovesAnything() throws Exception {
        Device d = withOldEntry();
        d.keystore.put("wot_v3_n01.99", (byte) 9); // a key no entry names
        process(d).read();
        process(d).read();
        assertEquals(List.of(), d.log);
        assertEquals(2, d.keystore.size());
    }

    @Test
    public void aFirstStoreAndRemoveTakeEveryNamedKey() throws Exception {
        Device d = new Device();
        process(d).store(OLD);
        assertNull(d.file.previousKey);
        process(d).store(NEW);
        // a replaced key whose removal failed is still named and goes with the remove
        d.keystore.put("wot_v3_n01.1", (byte) 1);
        assertTrue(process(d).remove());
        assertNull(d.file);
        assertTrue(d.keystore.isEmpty());
    }
}
