export declare function encodeBase58(bytes: Uint8Array): string;
export declare function decodeBase58(str: string): Uint8Array;
export declare function encodeBase64Url(bytes: Uint8Array): string;
export declare function decodeBase64Url(str: string): Uint8Array;
/** Standard Base64 encode (not URL-safe, with padding). Used for HTTP APIs. */
export declare function encodeBase64(bytes: Uint8Array): string;
/** Standard Base64 decode (not URL-safe). */
export declare function decodeBase64(str: string): Uint8Array;
/** Convert Uint8Array to ArrayBuffer slice (workaround for TypeScript strict mode with Web Crypto). */
export declare function toBuffer(arr: Uint8Array): ArrayBuffer;
//# sourceMappingURL=encoding.d.ts.map