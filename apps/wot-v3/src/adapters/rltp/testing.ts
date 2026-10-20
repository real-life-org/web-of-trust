// Test entry of the real adapter: what tests need from the library goes through here, so that only
// src/adapters/rltp imports it (architecture §1.1). Not imported by the app.
export { storeContract } from '@real-life/trust-protocol'
