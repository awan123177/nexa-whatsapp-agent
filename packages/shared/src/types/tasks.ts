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
