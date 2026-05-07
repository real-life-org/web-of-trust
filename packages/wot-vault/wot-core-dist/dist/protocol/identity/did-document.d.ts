export interface DidResolver {
    resolve(did: string): Promise<DidDocument | null>;
}
export interface DidDocument {
    id: string;
    verificationMethod: Array<{
        id: string;
        type: string;
        controller: string;
        publicKeyMultibase: string;
    }>;
    authentication: string[];
    assertionMethod: string[];
    keyAgreement: Array<{
        id: string;
        type: string;
        controller: string;
        publicKeyMultibase: string;
    }>;
    service?: Array<{
        id: string;
        type: string;
        serviceEndpoint: string;
    }>;
}
//# sourceMappingURL=did-document.d.ts.map