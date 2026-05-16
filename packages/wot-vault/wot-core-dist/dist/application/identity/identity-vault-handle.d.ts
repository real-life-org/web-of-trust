import { ProtocolCryptoAdapter } from '../../protocol';
import { IdentityEncryptedPayload, IdentityVaultUnlockHandle } from '../../types/identity-session';
export declare function createIdentityVaultUnlockHandle(bip39Seed: Uint8Array, cryptoAdapter: ProtocolCryptoAdapter): Promise<IdentityVaultUnlockHandle>;
export declare function encryptForRecipientUsingX25519(cryptoAdapter: ProtocolCryptoAdapter, plaintext: Uint8Array, recipientPublicKeyBytes: Uint8Array): Promise<IdentityEncryptedPayload>;
//# sourceMappingURL=identity-vault-handle.d.ts.map