import { ShoppingStepState } from '@nexa/shared';

const SHOPPING_ALLOWED_TRANSITIONS: Record<ShoppingStepState, Set<ShoppingStepState>> = {
  INITIAL: new Set(['SEARCHING', 'FAILED']),
  SEARCHING: new Set(['PRODUCT_FOUND', 'FAILED']),
  PRODUCT_FOUND: new Set(['PRODUCT_SELECTED', 'SEARCHING', 'FAILED']),
  PRODUCT_SELECTED: new Set(['CART_UPDATED', 'SEARCHING', 'FAILED']),
  CART_UPDATED: new Set(['CART_VERIFIED', 'FAILED']),
  CART_VERIFIED: new Set(['ADDRESS_SELECTED', 'CHECKOUT_READY', 'FAILED']),
  ADDRESS_SELECTED: new Set(['CHECKOUT_READY', 'FAILED']),
  CHECKOUT_READY: new Set(['WAITING_APPROVAL', 'FAILED']),
  WAITING_APPROVAL: new Set(['CHECKOUT_EXECUTED', 'FAILED']),
  CHECKOUT_EXECUTED: new Set(['ORDER_VERIFIED', 'FAILED']),
  ORDER_VERIFIED: new Set(['COMPLETED', 'FAILED']),
  COMPLETED: new Set([]), // Terminal
  FAILED: new Set([]), // Terminal - FAILED CAN NEVER TRANSITION TO COMPLETED
};

export class ShoppingStateMachine {
  private currentState: ShoppingStepState;
  private verifiedSteps: Set<ShoppingStepState> = new Set();
  private failedVerificationReason?: string;

  constructor(initialState: ShoppingStepState = 'INITIAL') {
    this.currentState = initialState;
  }

  public getState(): ShoppingStepState {
    return this.currentState;
  }

  public canTransitionTo(nextState: ShoppingStepState): boolean {
    const allowed = SHOPPING_ALLOWED_TRANSITIONS[this.currentState];
    return allowed ? allowed.has(nextState) : false;
  }

  public transitionTo(nextState: ShoppingStepState): void {
    if (!this.canTransitionTo(nextState)) {
      throw new Error(`Illegal shopping state transition: ${this.currentState} -> ${nextState}`);
    }
    this.currentState = nextState;
  }

  public recordVerifiedStep(step: ShoppingStepState): void {
    this.verifiedSteps.add(step);
    console.log(`[ShoppingStateMachine] step_verified state=${step}`);
  }

  public isStepVerified(step: ShoppingStepState): boolean {
    return this.verifiedSteps.has(step);
  }

  public recordVerificationFailure(reason: string): void {
    this.failedVerificationReason = reason;
    console.log(`[ShoppingStateMachine] verification_failed state=${this.currentState} reason="${reason}"`);
    this.transitionTo('FAILED');
  }

  public getFailureReason(): string | undefined {
    return this.failedVerificationReason;
  }
}
