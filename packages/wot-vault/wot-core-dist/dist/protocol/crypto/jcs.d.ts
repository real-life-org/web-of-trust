export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export declare function canonicalize(value: JsonValue): string;
export declare function canonicalizeToBytes(value: JsonValue): Uint8Array;
//# sourceMappingURL=jcs.d.ts.map