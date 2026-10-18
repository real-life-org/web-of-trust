// Identity runtime under the port (architecture §4.2, §5), shared by the real and the simulation adapter.
export { createIdentityRuntime, TERMS_VERSION, type IdentityRuntime } from './runtime'
export type { HolderHost, HolderKeys } from './host'
export type { InitInputs } from './sealed-init'
export { checkWords, generateWords, rootIkmFromWords, VALID_LENGTHS } from './mnemonic'
