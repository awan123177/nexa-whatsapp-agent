import { TaskState } from '@nexa/shared';

const ALLOWED_TRANSITIONS: Record<TaskState, Set<TaskState>> = {
  CREATED: new Set(['PLANNING', 'EXECUTING', 'FAILED']),
  PLANNING: new Set(['EXECUTING', 'WAITING_AUTH', 'WAITING_APPROVAL', 'BLOCKED', 'FAILED']),
  EXECUTING: new Set([
    'VERIFYING',
    'RECOVERING',
    'WAITING_AUTH',
    'WAITING_APPROVAL',
    'EXECUTING_PAYMENT',
    'BLOCKED',
    'FAILED',
    'COMPLETED', // For pure conversational/info queries where no tools are called
  ]),
  WAITING_AUTH: new Set(['AUTHENTICATING', 'EXECUTING', 'BLOCKED', 'FAILED']),
  AUTHENTICATING: new Set(['EXECUTING', 'WAITING_AUTH', 'BLOCKED', 'FAILED']),
  WAITING_APPROVAL: new Set(['EXECUTING_PAYMENT', 'EXECUTING', 'COMPLETED', 'FAILED']),
  EXECUTING_PAYMENT: new Set(['VERIFYING', 'RECOVERING', 'FAILED']),
  VERIFYING: new Set(['COMPLETED', 'RECOVERING', 'EXECUTING', 'FAILED']),
  RECOVERING: new Set(['EXECUTING', 'VERIFYING', 'FAILED', 'BLOCKED']),
  BLOCKED: new Set(['RECOVERING', 'FAILED']),
  COMPLETED: new Set([]), // Terminal
  FAILED: new Set([]), // Terminal - FAILED CAN NEVER TRANSITION TO COMPLETED!
};

export class TaskStateMachine {
  private currentState: TaskState;

  constructor(initialState: TaskState = 'CREATED') {
    this.currentState = initialState;
  }

  public getState(): TaskState {
    return this.currentState;
  }

  public canTransitionTo(nextState: TaskState): boolean {
    const allowed = ALLOWED_TRANSITIONS[this.currentState];
    return allowed ? allowed.has(nextState) : false;
  }

  public transitionTo(nextState: TaskState): void {
    if (!this.canTransitionTo(nextState)) {
      throw new Error(`Illegal task state transition: ${this.currentState} -> ${nextState}`);
    }
    this.currentState = nextState;
  }
}
