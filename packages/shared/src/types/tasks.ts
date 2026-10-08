export type TaskState =
  | 'CREATED'
  | 'PLANNING'
  | 'EXECUTING'
  | 'WAITING_AUTH'
  | 'AUTHENTICATING'
  | 'WAITING_APPROVAL'
  | 'EXECUTING_PAYMENT'
  | 'VERIFYING'
  | 'RECOVERING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED';

export interface TaskCheckpoint {
  taskId: string;
  userId: string;
  state: TaskState;
  currentStep: number;
  maxSteps: number;
  plan: string[];
  merchant?: string;
  externalReference?: string;
  verificationState: {
    verified: boolean;
    step?: string;
    details?: Record<string, unknown>;
  };
  browserSessionId?: string;
  lastVerifiedState?: Record<string, unknown>;
  updatedAt: number;
}

export type ShoppingStepState =
  | 'INITIAL'
  | 'SEARCHING'
  | 'PRODUCT_FOUND'
  | 'PRODUCT_SELECTED'
  | 'CART_UPDATED'
  | 'CART_VERIFIED'
  | 'ADDRESS_SELECTED'
  | 'CHECKOUT_READY'
  | 'WAITING_APPROVAL'
  | 'CHECKOUT_EXECUTED'
  | 'ORDER_VERIFIED'
  | 'COMPLETED'
  | 'FAILED';

export type MessageIntent =
  | 'CONVERSATION'
  | 'RESEARCH'
  | 'SHOPPING'
  | 'TRAVEL'
  | 'EMAIL'
  | 'CALENDAR'
  | 'WALLET'
  | 'OTHER';

export interface ActiveRequestContext {
  requestId: string;
  taskId: string;
  intent: MessageIntent;
  userMessage: string;
  isContinuation: boolean;
  resumedTaskId?: string;
  timestamp: number;
}
