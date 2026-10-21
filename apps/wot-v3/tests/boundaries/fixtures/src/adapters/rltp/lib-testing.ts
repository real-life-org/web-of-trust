// Negative fixture: the library's testing entry in the real adapter (rule no-test-doubles-in-src).
import { InMemoryStore } from '@real-life/trust-protocol/testing'
export const store = new InMemoryStore()
