export declare class NexaError extends Error {
    readonly code: string;
    readonly statusCode: number;
    readonly isOperational: boolean;
    readonly userFacingMessage: string;
    constructor(message: string, options?: {
        code?: string;
        statusCode?: number;
        isOperational?: boolean;
        userFacingMessage?: string;
    });
}
export declare class ApprovalRequiredError extends NexaError {
    readonly approvalId: string;
    readonly toolName: string;
    readonly toolArguments: Record<string, unknown>;
    readonly prompt: string;
    constructor(params: {
        approvalId: string;
        toolName: string;
        toolArguments: Record<string, unknown>;
        prompt: string;
    });
}
export declare class ToolExecutionError extends NexaError {
    constructor(toolName: string, message: string, userFacingMessage?: string);
}
export declare class SecurityViolationError extends NexaError {
    constructor(message: string, code?: string);
}
export declare class RateLimitError extends NexaError {
    constructor(message?: string);
}
export declare class WebhookVerificationError extends NexaError {
    constructor(message?: string);
}
//# sourceMappingURL=index.d.ts.map