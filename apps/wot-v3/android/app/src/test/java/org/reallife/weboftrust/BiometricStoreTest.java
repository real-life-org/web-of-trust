package org.reallife.weboftrust;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyPermanentlyInvalidatedException;

import androidx.test.core.app.ApplicationProvider;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * BiometricStore on the real android.util.AtomicFile, the real file system and the real
 * SharedPreferences (Robolectric, API 28 with the backup-file AtomicFile and API 35 with the new-file
 * one); the Keystore is an in-memory KeyVault that fails like the AndroidKeyStore.
 *
 * Invariant in every case: after a failure or a process abort the old or the new confirmed entry stays
 * decryptable; when the state is unclear no key that may still be needed is removed; reading never
 * changes anything.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {28, 35})
public class BiometricStoreTest {

    private static final String NS = "wot_v3_n0123456789abcdef";
    private static final byte[] OLD = "old secret".getBytes();
    private static final byte[] NEW = "new secret".getBytes();

    /** an in-memory Keystore: XOR keys, KeyPermanentlyInvalidatedException for invalidated keys */
    static final class MemoryVault implements BiometricStore.KeyVault {
        final Map<String, Byte> keys = new HashMap<>();
        final Set<String> invalidated = new HashSet<>();
        final List<String> deleted = new ArrayList<>();
        String failCreate = null;
        private byte next = 1;

        @Override public synchronized void create(String name) throws Exception {
            if (failCreate != null) throw new Exception(failCreate);
            keys.put(name, next++);
        }

        @Override public synchronized boolean exists(String name) { return keys.containsKey(name); }

        @Override public synchronized byte[][] encrypt(String name, byte[] plain) {
            return new byte[][] {xor(plain, keys.get(name)), new byte[] {7}};
        }

        @Override public synchronized void probe(String name, byte[] iv) throws Exception {
            if (invalidated.contains(name)) throw new KeyPermanentlyInvalidatedException();
        }

        @Override public synchronized byte[] decrypt(String name, byte[] iv, byte[] ciphertext) throws Exception {
            if (invalidated.contains(name)) throw new KeyPermanentlyInvalidatedException();
            Byte k = keys.get(name);
            if (k == null) throw new IllegalStateException("no key " + name);
            return xor(ciphertext, k);
        }

        @Override public synchronized void delete(String name) {
            deleted.add(name);
            keys.remove(name);
        }

        static byte[] xor(byte[] in, byte k) {
            byte[] out = in.clone();
            for (int i = 0; i < out.length; i++) out[i] ^= k;
            return out;
        }
    }

    /** a process abort: nothing after it runs, so the store must not catch it */
    static final class ProcessDeath extends Error { }

    private Context context;
    private File dir;
    private SharedPreferences legacy;
    private MemoryVault vault;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        dir = new File(context.getNoBackupFilesDir(), "wot_biometric");
        legacy = context.getSharedPreferences("wot_biometric_prefs", Context.MODE_PRIVATE);
        vault = new MemoryVault();
    }

    /** a new process: a new store over the same files, Keystore and preferences */
    private BiometricStore process() {
        return new BiometricStore(dir, vault, legacy);
    }

    private BiometricStore withOldEntry() throws Exception {
        BiometricStore s = process();
        s.store(NS, OLD);
        return s;
    }

    /** every file below dir with its bytes, and the Keystore: what reading must leave unchanged */
    private String snapshot() throws IOException {
        TreeMap<String, String> files = new TreeMap<>();
        File[] list = dir.listFiles();
        if (list != null) for (File f : list) files.put(f.getName(), Arrays.toString(Files.readAllBytes(f.toPath())));
        return files + " " + new TreeMap<>(vault.keys);
    }

    @Test
    public void storeThenUnlockAfterARestart() throws Exception {
        withOldEntry();
        BiometricStore restarted = process();
        assertTrue(restarted.has(NS));
        restarted.checkUnlock(NS);
        assertArrayEquals(OLD, restarted.unlock(NS));
        assertEquals(1, vault.keys.size());
    }

    @Test
    public void aReplacementRemovesTheOldKeyOnlyAfterTheDiskNamesTheNewOne() throws Exception {
        BiometricStore s = withOldEntry();
        Set<String> before = new HashSet<>(vault.keys.keySet());
        s.writeHook = () -> assertEquals("the old key stays while the write is open", before, keysOf(before));
        s.store(NS, NEW);
        assertArrayEquals(NEW, process().unlock(NS));
        assertEquals(1, vault.keys.size());
        assertTrue(vault.deleted.containsAll(before));
    }

    private Set<String> keysOf(Set<String> names) {
        Set<String> out = new HashSet<>();
        for (String n : names) if (vault.keys.containsKey(n)) out.add(n);
        return out;
    }

    @Test
    public void aFailedWriteKeepsTheOldEntryAndRemovesOnlyTheFreshKey() throws Exception {
        BiometricStore s = withOldEntry();
        Set<String> before = new HashSet<>(vault.keys.keySet());
        s.writeHook = () -> { throw new IOException("no space left on device"); };
        try {
            s.store(NS, NEW);
            fail("expected the store to fail");
        } catch (IOException expected) {
            // AUTH_FAILED to the app
        }
        // has and unlock in the same process, then a restart
        assertTrue(s.has(NS));
        assertArrayEquals(OLD, s.unlock(NS));
        assertArrayEquals(OLD, process().unlock(NS));
        assertEquals(before, vault.keys.keySet());
    }

    @Test
    public void aProcessAbortBetweenStartWriteAndFinishWriteKeepsTheOldEntry() throws Exception {
        BiometricStore s = withOldEntry();
        Set<String> before = new HashSet<>(vault.keys.keySet());
        s.writeHook = () -> { throw new ProcessDeath(); };
        try {
            s.store(NS, NEW);
            fail("expected the abort");
        } catch (ProcessDeath expected) {
            // the process is gone: the files hold the state between startWrite and finishWrite
        }
        BiometricStore restarted = process();
        assertTrue(restarted.has(NS));
        assertArrayEquals(OLD, restarted.unlock(NS));
        // no key the old entry needs was removed; the fresh key may stay behind unnamed
        assertTrue(vault.keys.keySet().containsAll(before));
    }

    @Test
    public void aReadDuringAWriteWaitsAndDoesNotRollItBack() throws Exception {
        // issue #444: AtomicFile.readFully rolls back a write in progress; reading takes the same lock
        BiometricStore writer = withOldEntry();
        BiometricStore reader = process();
        AtomicReference<Boolean> seen = new AtomicReference<>();
        AtomicReference<Throwable> readerFailure = new AtomicReference<>();
        CountDownLatch readerStarted = new CountDownLatch(1);
        Thread[] readerThread = new Thread[1];
        writer.writeHook = () -> {
            readerThread[0] = new Thread(() -> {
                readerStarted.countDown();
                try {
                    seen.set(reader.has(NS));
                } catch (Throwable t) {
                    readerFailure.set(t);
                }
            });
            readerThread[0].start();
            assertTrue(readerStarted.await(5, TimeUnit.SECONDS));
            // give an unlocked read every chance to run between startWrite and finishWrite
            readerThread[0].join(500);
        };
        writer.store(NS, NEW);
        readerThread[0].join(5000);
        assertEquals(null, readerFailure.get());
        assertEquals(Boolean.TRUE, seen.get());
        assertArrayEquals(NEW, writer.unlock(NS));
        assertArrayEquals(NEW, process().unlock(NS));
        assertEquals(1, vault.keys.size());
    }

    @Test
    public void readingNeverChangesAnything() throws Exception {
        BiometricStore s = withOldEntry();
        vault.keys.put(NS + ".unnamed", (byte) 99); // a key no entry names
        String before = snapshot();
        s.has(NS);
        s.checkUnlock(NS);
        s.unlock(NS);
        process().has(NS);
        assertEquals(before, snapshot());
        assertEquals(List.of(), vault.deleted);
    }

    @Test
    public void anInvalidatedOrMissingKeyIsReportedAndTheEntryStays() throws Exception {
        BiometricStore s = withOldEntry();
        String key = vault.keys.keySet().iterator().next();
        vault.invalidated.add(key);
        String before = snapshot();
        assertEquals("KEY_INVALIDATED", codeOf(() -> s.checkUnlock(NS)));
        assertEquals("KEY_INVALIDATED", codeOf(() -> s.unlock(NS)));
        assertEquals(before, snapshot());
        vault.keys.remove(key);
        assertEquals("KEY_NOT_FOUND", codeOf(() -> s.checkUnlock(NS)));
        assertTrue("the entry stays until the app removes or replaces it", s.has(NS));
        // the app replaces it: the stale key is no obstacle
        vault.invalidated.clear();
        s.store(NS, NEW);
        assertArrayEquals(NEW, process().unlock(NS));
    }

    @Test
    public void noEntryIsKeyNotFoundAndAFailedKeyCreationChangesNothing() throws Exception {
        BiometricStore s = process();
        assertFalse(s.has(NS));
        assertEquals("KEY_NOT_FOUND", codeOf(() -> s.unlock(NS)));
        vault.failCreate = "keystore full";
        try {
            s.store(NS, NEW);
            fail("expected a failure");
        } catch (Exception expected) {
            // AUTH_FAILED
        }
        assertFalse(s.has(NS));
        assertTrue(vault.keys.isEmpty());
    }

    @Test
    public void removeTakesTheEntryAndEveryKeyItNamed() throws Exception {
        BiometricStore s = withOldEntry();
        String first = vault.keys.keySet().iterator().next();
        s.store(NS, NEW);
        // a replaced key whose removal failed is still named as previousKey
        vault.keys.put(first, (byte) 1);
        assertTrue(s.remove(NS));
        assertFalse(process().has(NS));
        assertTrue(vault.keys.isEmpty());
    }

    @Test
    public void theGen2EntryIsOnlyFoundAndRemoved() throws Exception {
        assertTrue(legacy.edit().putString(BiometricStore.LEGACY_PREF_CIPHERTEXT, "c").putString(BiometricStore.LEGACY_PREF_IV, "i").commit());
        vault.keys.put(BiometricStore.LEGACY_ALIAS, (byte) 5);
        BiometricStore s = process();
        assertTrue(s.has(BiometricStore.LEGACY_ALIAS));
        assertFalse("v3 namespaces never see it", s.has(NS));
        assertTrue(s.remove(BiometricStore.LEGACY_ALIAS));
        assertFalse(process().has(BiometricStore.LEGACY_ALIAS));
        assertFalse(vault.keys.containsKey(BiometricStore.LEGACY_ALIAS));
    }

    interface Call {
        void run() throws Exception;
    }

    private static String codeOf(Call c) {
        try {
            c.run();
            return "none";
        } catch (BiometricStore.Failure f) {
            return f.code;
        } catch (Exception e) {
            return e.toString();
        }
    }
}
