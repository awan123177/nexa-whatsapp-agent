import { TaskState } from '@nexa/shared';

const ALLOWED_TRANSITIONS: Record<TaskState, Set<TaskState>> = {
  CREATED: new Set(['QUEUED', 'PLANNING', 'RUNNING', 'EXECUTING', 'PAUSED', 'FAILED', 'CANCELLED']),
  QUEUED: new Set(['PLANNING', 'RUNNING', 'EXECUTING', 'PAUSED', 'FAILED', 'CANCELLED']),
  PLANNING: new Set([
    'RUNNING',
    'EXECUTING',
    'WAITING_FOR_USER',
    'WAITING_AUTH',
    'WAITING_APPROVAL',
    'PAUSED',
    'BLOCKED',
    'FAILED',
    'CANCELLED',
    'COMPLETED',
  ]),
  RUNNING: new Set([
    'PLANNING',
    'EXECUTING',
    'WAITING_FOR_USER',
    'WAITING_AUTH',
    'WAITING_APPROVAL',
    'PAUSED',
    'BLOCKED',
    'FAILED',
    'CANCELLED',
    'COMPLETED',
  ]),
  EXECUTING: new Set([
    'RUNNING',
    'VERIFYING',
    'RECOVERING',
    'WAITING_FOR_USER',
    'WAITING_AUTH',
    'WAITING_APPROVAL',
    'EXECUTING_PAYMENT',
    'PAUSED',
    'BLOCKED',
    'FAILED',
    'COMPLETED', // For pure conversational/info queries where no tools are called
    'CANCELLED',
  ]),
  WAITING_FOR_USER: new Set(['RUNNING', 'EXECUTING', 'PLANNING', 'PAUSED', 'FAILED', 'CANCELLED', 'COMPLETED']),
  WAITING_AUTH: new Set(['AUTHENTICATING', 'EXECUTING', 'RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED']),
  AUTHENTICATING: new Set(['EXECUTING', 'RUNNING', 'WAITING_AUTH', 'BLOCKED', 'FAILED', 'CANCELLED']),
  WAITING_APPROVAL: new Set(['EXECUTING_PAYMENT', 'EXECUTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']),
  EXECUTING_PAYMENT: new Set(['VERIFYING', 'RECOVERING', 'FAILED', 'CANCELLED']),
  VERIFYING: new Set(['COMPLETED', 'RECOVERING', 'EXECUTING', 'RUNNING', 'FAILED', 'CANCELLED']),
  RECOVERING: new Set(['EXECUTING', 'RUNNING', 'VERIFYING', 'FAILED', 'BLOCKED', 'CANCELLED']),
  PAUSED: new Set(['RUNNING', 'EXECUTING', 'PLANNING', 'FAILED', 'CANCELLED']),
  BLOCKED: new Set(['RECOVERING', 'FAILED', 'CANCELLED']),
  COMPLETED: new Set([]), // Terminal
  FAILED: new Set([]), // Terminal - FAILED CAN NEVER TRANSITION TO COMPLETED!
  CANCELLED: new Set([]), // Terminal - CANCELLED CAN NEVER TRANSITION TO COMPLETED!
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

  public isTerminal(): boolean {
    return (
      this.currentState === 'COMPLETED' ||
      this.currentState === 'FAILED' ||
      this.currentState === 'CANCELLED' ||
      this.currentState === 'BLOCKED'
    );
  }

  public isBlocked(): boolean {
    return this.currentState === 'BLOCKED';
  }

  public transitionTo(nextState: TaskState): void {
    if (!this.canTransitionTo(nextState)) {
      throw new Error(`Illegal task state transition: ${this.currentState} -> ${nextState}`);
    }
    this.currentState = nextState;
  }
}
