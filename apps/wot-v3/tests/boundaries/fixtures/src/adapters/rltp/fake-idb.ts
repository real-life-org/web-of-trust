// Negative fixture: a test double in the real adapter (rule no-test-doubles-in-src).
import { IDBFactory } from 'fake-indexeddb'
export const idb = new IDBFactory()
