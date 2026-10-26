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

    /**
     * An in-memory Keystore that fails where the AndroidKeyStore fails: KeyPermanentlyInvalidatedException
     * for an invalidated key, UserNotAuthenticatedException when decrypting without an authentication,
     * a Keystore error on exists/create/encrypt, and a delete that silently does nothing.
     */
    static final class MemoryVault implements BiometricStore.KeyVault {
        final Map<String, Byte> keys = new HashMap<>();
        final Set<String> invalidated = new HashSet<>();
        final List<String> deleted = new ArrayList<>();
        String failCreate = null;
        boolean failExists = false;
        boolean failEncrypt = false;
        boolean deleteIsNoop = false;
        boolean unauthenticated = false;
        private byte next = 1;

        @Override public synchronized void create(String name) throws Exception {
            if (failCreate != null) throw new java.security.KeyStoreException(failCreate);
            keys.put(name, next++);
        }

        @Override public synchronized boolean exists(String name) throws Exception {
            if (failExists) throw new java.security.KeyStoreException("keystore unavailable");
            return keys.containsKey(name);
        }

        @Override public synchronized byte[][] encrypt(String name, byte[] plain) throws Exception {
            if (failEncrypt) throw new java.security.InvalidKeyException("key not usable");
            Byte k = keys.get(name);
            if (k == null) throw new IllegalStateException("no key " + name);
            return new byte[][] {xor(plain, k), new byte[] {7}};
        }

        @Override public synchronized List<String> names(String prefix) {
            List<String> out = new ArrayList<>();
            for (String k : keys.keySet()) if (k.startsWith(prefix)) out.add(k);
            return out;
        }

        @Override public synchronized void probe(String name, byte[] iv) throws Exception {
            if (invalidated.contains(name)) throw new KeyPermanentlyInvalidatedException();
        }

        @Override public synchronized byte[] decrypt(String name, byte[] iv, byte[] ciphertext) throws Exception {
            if (invalidated.contains(name)) throw new KeyPermanentlyInvalidatedException();
            if (unauthenticated) throw new android.security.keystore.UserNotAuthenticatedException();
            Byte k = keys.get(name);
            if (k == null) throw new IllegalStateException("no key " + name);
            return xor(ciphertext, k);
        }

        @Override public synchronized void delete(String name) {
            deleted.add(name);
            if (!deleteIsNoop) keys.remove(name);
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
    public void aReadDuringAWriteWaitsAtTheLockAndDoesNotRollItBack() throws Exception {
        // issue #444: AtomicFile.readFully rolls back a write in progress; reading takes the same lock.
        // The writer holds the write open until the reader provably waits at the lock.
        BiometricStore writer = withOldEntry();
        BiometricStore reader = process();
        AtomicReference<Boolean> seen = new AtomicReference<>();
        AtomicReference<Throwable> readerFailure = new AtomicReference<>();
        Thread readerThread = new Thread(() -> {
            try {
                seen.set(reader.has(NS));
            } catch (Throwable t) {
                readerFailure.set(t);
            }
        });
        writer.writeHook = () -> {
            readerThread.start();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (!BiometricStore.waitsForLock(readerThread)) {
                if (!readerThread.isAlive()) fail("the reader read during the open write instead of waiting");
                if (System.nanoTime() > deadline) fail("the reader never reached the lock");
                Thread.sleep(5);
            }
            assertTrue("the reader is not done while the write is open", readerThread.isAlive());
            assertEquals(null, seen.get());
        };
        writer.store(NS, NEW);
        readerThread.join(10000);
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

    private File entryFile() {
        return new File(dir, NS + ".json");
    }

    @Test
    public void anUnreadableEntryDoesNotLockTheNamespace() throws Exception {
        // API 26-29: an abort during the first store can leave an empty or half base file
        for (String content : new String[] {"", "{\"key\":\"wot_v3_n0123456789abcdef.1\",\"previ"}) {
            vault.keys.clear();
            assertTrue(dir.isDirectory() || dir.mkdirs());
            Files.write(entryFile().toPath(), content.getBytes());
            vault.keys.put(NS + ".lost", (byte) 3); // the key the half file may have named
            BiometricStore s = process();
            assertFalse(s.has(NS));
            assertEquals("KEY_NOT_FOUND", codeOf(() -> s.checkUnlock(NS)));
            // store writes over it and removes no key it cannot tell
            s.store(NS, NEW);
            assertArrayEquals(NEW, process().unlock(NS));
            assertTrue("unclear: the key stays", vault.keys.containsKey(NS + ".lost"));
            // a second unreadable file: remove deletes it, then every key of the namespace
            Files.write(entryFile().toPath(), content.getBytes());
            assertTrue(process().remove(NS));
            assertFalse(process().has(NS));
            assertTrue(vault.keys.isEmpty());
        }
    }

    @Test
    public void removeCollectsTheKeysNoEntryNamesOnlyOfItsNamespace() throws Exception {
        BiometricStore s = withOldEntry();
        // an abort between creating the fresh key and finishing the write leaves an unnamed key
        s.writeHook = () -> { throw new ProcessDeath(); };
        try {
            s.store(NS, NEW);
        } catch (ProcessDeath expected) {
            // the process is gone
        }
        vault.keys.put(NS + "x.other", (byte) 4); // another namespace whose name starts the same
        vault.keys.put("wot_v3_n9.k", (byte) 5);
        assertEquals(3, vault.names(NS).size());
        assertTrue(process().remove(NS));
        assertEquals(new HashSet<>(List.of(NS + "x.other", "wot_v3_n9.k")), vault.keys.keySet());
    }

    @Test
    public void keystoreFailuresChangeNothingAndAreReported() throws Exception {
        BiometricStore s = withOldEntry();
        String before = snapshot();
        vault.failExists = true;
        assertEquals("AUTH_FAILED", codeOf(() -> s.checkUnlock(NS)));
        assertEquals("AUTH_FAILED", codeOf(() -> s.unlock(NS)));
        vault.failExists = false;
        vault.unauthenticated = true;
        assertEquals("AUTH_FAILED", codeOf(() -> s.unlock(NS)));
        vault.unauthenticated = false;
        assertEquals(before, snapshot());
        // create succeeds, encrypt fails: only the fresh key goes, the old entry stays
        vault.failEncrypt = true;
        assertTrue(codeOf(() -> s.store(NS, NEW)).contains("InvalidKeyException"));
        vault.failEncrypt = false;
        assertEquals(before, snapshot());
        assertArrayEquals(OLD, process().unlock(NS));
    }

    @Test
    public void aDeleteTheKeystoreRefusesLeavesAKeyThatRemoveCollectsLater() throws Exception {
        BiometricStore s = withOldEntry();
        vault.deleteIsNoop = true;
        s.store(NS, NEW);
        assertArrayEquals(NEW, process().unlock(NS));
        assertEquals("the old key stayed behind unnamed", 2, vault.keys.size());
        assertTrue(s.remove(NS));
        assertEquals(2, vault.keys.size());
        vault.deleteIsNoop = false;
        assertTrue("a second remove collects them", process().remove(NS));
        assertTrue(vault.keys.isEmpty());
    }

    @Test
    public void theGen2KeyGoesOnlyAfterThePreferencesAreWritten() throws Exception {
        assertTrue(legacy.edit().putString(BiometricStore.LEGACY_PREF_CIPHERTEXT, "c").putString(BiometricStore.LEGACY_PREF_IV, "i").commit());
        vault.keys.put(BiometricStore.LEGACY_ALIAS, (byte) 5);
        SharedPreferences failing = failingCommit(legacy);
        assertFalse(new BiometricStore(dir, vault, failing).remove(BiometricStore.LEGACY_ALIAS));
        assertTrue(vault.keys.containsKey(BiometricStore.LEGACY_ALIAS));
    }

    /** SharedPreferences whose commit reports a failed write */
    private static SharedPreferences failingCommit(SharedPreferences real) {
        SharedPreferences.Editor editor = (SharedPreferences.Editor) java.lang.reflect.Proxy.newProxyInstance(
            SharedPreferences.Editor.class.getClassLoader(), new Class<?>[] {SharedPreferences.Editor.class},
            (proxy, method, args) -> method.getName().equals("commit") ? Boolean.FALSE : proxy);
        return (SharedPreferences) java.lang.reflect.Proxy.newProxyInstance(
            SharedPreferences.class.getClassLoader(), new Class<?>[] {SharedPreferences.class},
            (proxy, method, args) -> method.getName().equals("edit") ? editor : method.invoke(real, args));
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
