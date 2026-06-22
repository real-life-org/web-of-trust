import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // The spike is CPU-bound crypto (Ed25519/AES per log entry). Running files in
    // parallel workers oversubscribes the CPU and trips per-test timeouts; serial
    // execution keeps timing deterministic and the whole suite still finishes fast.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
  },
})
