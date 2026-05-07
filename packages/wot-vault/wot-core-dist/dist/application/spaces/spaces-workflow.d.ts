import { SpaceMemberKeyDirectory, SpaceReplicationPort } from '../../ports';
import { SpaceDocMeta, SpaceInfo } from '../../types/space';
export interface SpacesWorkflowOptions {
    replication: SpaceReplicationPort;
    memberKeys?: SpaceMemberKeyDirectory;
    appTag?: string;
    defaultInitialDoc?: () => unknown;
}
export interface CreateSpaceInput {
    name: string;
    description?: string;
    type?: SpaceInfo['type'];
    initialDoc?: unknown;
    appTag?: string;
}
export interface InviteMemberInput {
    spaceId: string;
    memberDid: string;
}
export declare class SpacesWorkflow {
    private readonly replication;
    private readonly memberKeys;
    private readonly appTag;
    private readonly createDefaultInitialDoc;
    constructor(options: SpacesWorkflowOptions);
    watchSpaces(): import('../../ports').SpaceListSubscription;
    listSpaces(): Promise<SpaceInfo[]>;
    getSpace(spaceId: string): Promise<SpaceInfo | null>;
    createSpace(input: CreateSpaceInput): Promise<SpaceInfo>;
    updateSpace(spaceId: string, meta: SpaceDocMeta): Promise<void>;
    inviteMember(input: InviteMemberInput): Promise<void>;
    removeMember(input: InviteMemberInput): Promise<void>;
    leaveSpace(spaceId: string): Promise<void>;
    requestSync(spaceId?: string): Promise<void>;
    private requireMemberKeys;
}
//# sourceMappingURL=spaces-workflow.d.ts.map