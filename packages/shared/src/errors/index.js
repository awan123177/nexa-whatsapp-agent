"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookVerificationError = exports.RateLimitError = exports.SecurityViolationError = exports.ToolExecutionError = exports.ApprovalRequiredError = exports.NexaError = void 0;
class NexaError extends Error {
    code;
    statusCode;
    isOperational;
    userFacingMessage;
    constructor(message, options = {}) {
        super(message);
        this.name = this.constructor.name;
        this.code = options.code || 'NEXA_INTERNAL_ERROR';
        this.statusCode = options.statusCode || 500;
        this.isOperational = options.isOperational ?? true;
        this.userFacingMessage =
            options.userFacingMessage ||
                'I encountered an unexpected issue while processing your request. Please try again.';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.NexaError = NexaError;
class ApprovalRequiredError extends NexaError {
    approvalId;
    toolName;
    toolArguments;
    prompt;
    constructor(params) {
        super(`Action requires user approval: ${params.toolName}`, {
            code: 'APPROVAL_REQUIRED',
            statusCode: 200, // Not an HTTP failure, but an intentional workflow state
            userFacingMessage: params.prompt,
        });
        this.approvalId = params.approvalId;
        this.toolName = params.toolName;
        this.toolArguments = params.toolArguments;
        this.prompt = params.prompt;
    }
}
exports.ApprovalRequiredError = ApprovalRequiredError;
class ToolExecutionError extends NexaError {
    constructor(toolName, message, userFacingMessage) {
        super(`Tool ${toolName} execution failed: ${message}`, {
            code: 'TOOL_EXECUTION_ERROR',
            statusCode: 400,
            userFacingMessage: userFacingMessage ||
                `I attempted to use ${toolName} but encountered an error: ${message}`,
        });
    }
}
exports.ToolExecutionError = ToolExecutionError;
class SecurityViolationError extends NexaError {
    constructor(message, code = 'SECURITY_VIOLATION') {
        super(`Security policy blocked action: ${message}`, {
            code,
            statusCode: 403,
            userFacingMessage: 'This action was blocked by security and safety policies.',
        });
    }
}
exports.SecurityViolationError = SecurityViolationError;
class RateLimitError extends NexaError {
    constructor(message = 'Rate limit exceeded') {
        super(message, {
            code: 'RATE_LIMIT_EXCEEDED',
            statusCode: 429,
            userFacingMessage: 'You have sent too many requests in a short period. Please wait a moment before sending another message.',
        });
    }
}
exports.RateLimitError = RateLimitError;
class WebhookVerificationError extends NexaError {
    constructor(message = 'Invalid webhook signature or token') {
        super(message, {
            code: 'INVALID_WEBHOOK_SIGNATURE',
            statusCode: 401,
            userFacingMessage: 'Webhook verification failed.',
        });
    }
}
exports.WebhookVerificationError = WebhookVerificationError;
//# sourceMappingURL=index.js.map