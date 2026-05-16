import { BrokerErrorBody } from './broker-error';
export declare const ERROR_CONTROL_FRAME_TYPE: "error/1.0";
export interface BrokerErrorControlFrame {
    type: typeof ERROR_CONTROL_FRAME_TYPE;
    thid: string | null;
    body: BrokerErrorBody;
}
export interface CreateBrokerErrorControlFrameOptions {
    thid: string | null;
    body: BrokerErrorBody;
}
export declare function createBrokerErrorControlFrame(options: CreateBrokerErrorControlFrameOptions): BrokerErrorControlFrame;
export declare function parseBrokerErrorControlFrame(value: unknown): BrokerErrorControlFrame;
export declare function assertBrokerErrorControlFrame(value: unknown): asserts value is BrokerErrorControlFrame;
//# sourceMappingURL=broker-control-frame.d.ts.map