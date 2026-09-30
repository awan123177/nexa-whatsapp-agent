export class NexaError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly userFacingMessage: string;

  constructor(
    message: string,
    options: {
      code?: string;
      statusCode?: number;
      isOperational?: boolean;
      userFacingMessage?: string;
    } = {}
  ) {
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

export class ApprovalRequiredError extends NexaError {
  public readonly approvalId: string;
  public readonly toolName: string;
  public readonly toolArguments: Record<string, unknown>;
  public readonly prompt: string;

  constructor(params: {
    approvalId: string;
    toolName: string;
    toolArguments: Record<string, unknown>;
    prompt: string;
  }) {
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

export class ToolExecutionError extends NexaError {
  constructor(toolName: string, message: string, userFacingMessage?: string) {
    super(`Tool ${toolName} execution failed: ${message}`, {
      code: 'TOOL_EXECUTION_ERROR',
      statusCode: 400,
      userFacingMessage:
        userFacingMessage ||
        `I attempted to use ${toolName} but encountered an error: ${message}`,
    });
  }
}

export class SecurityViolationError extends NexaError {
  constructor(message: string, code = 'SECURITY_VIOLATION') {
    super(`Security policy blocked action: ${message}`, {
      code,
      statusCode: 403,
      userFacingMessage:
        'This action was blocked by security and safety policies.',
    });
  }
}

export class RateLimitError extends NexaError {
  constructor(message = 'Rate limit exceeded') {
    super(message, {
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429,
      userFacingMessage:
        'You have sent too many requests in a short period. Please wait a moment before sending another message.',
    });
  }
}

export class WebhookVerificationError extends NexaError {
  constructor(message = 'Invalid webhook signature or token') {
    super(message, {
      code: 'INVALID_WEBHOOK_SIGNATURE',
      statusCode: 401,
      userFacingMessage: 'Webhook verification failed.',
    });
  }
}

export class AuthenticationError extends NexaError {
  constructor(message = 'Authentication required', userFacingMessage?: string) {
    super(message, {
      code: 'AUTHENTICATION_REQUIRED',
      statusCode: 401,
      userFacingMessage:
        userFacingMessage || 'You must be authenticated to perform this action.',
    });
  }
}
