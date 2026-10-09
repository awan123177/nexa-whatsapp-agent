import { ShoppingStepState } from '@nexa/shared';

export type ShoppingWorkflowPhase =
  | 'INITIAL'
  | 'SEARCH'
  | 'SELECT_PRODUCT'
  | 'VERIFY_PRODUCT'
  | 'ADD_TO_CART'
  | 'VERIFY_CART'
  | 'CAPTURE_SCREENSHOT'
  | 'DELIVER_SCREENSHOT'
  | 'COMPLETED'
  | 'FAILED';

export const SHOPPING_WORKFLOW_PHASE_ORDER: Record<ShoppingWorkflowPhase, number> = {
  INITIAL: 0,
  SEARCH: 1,
  SELECT_PRODUCT: 2,
  VERIFY_PRODUCT: 3,
  ADD_TO_CART: 4,
  VERIFY_CART: 5,
  CAPTURE_SCREENSHOT: 6,
  DELIVER_SCREENSHOT: 7,
  COMPLETED: 8,
  FAILED: 99,
};

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

export interface SelectedShoppingProduct {
  asin?: string;
  title: string;
  price?: number;
  packSize?: number;
  url?: string;
  selector?: string;
}

export interface VerifiedCartSummary {
  itemCount: number;
  totalMinor?: number;
  formattedTotal?: string;
  items?: Array<{ name: string; quantity: number; priceMinor?: number }>;
}

export class ShoppingStateMachine {
  private currentState: ShoppingStepState;
  private currentPhase: ShoppingWorkflowPhase = 'INITIAL';
  private verifiedSteps: Set<ShoppingStepState> = new Set();
  private verifiedPhases: Set<ShoppingWorkflowPhase> = new Set();
  private failedVerificationReason?: string;
  private selectedProduct?: SelectedShoppingProduct;
  private currentUrl?: string;
  private verifiedCart?: VerifiedCartSummary;
  private screenshotDelivered = false;
  private screenshotMediaId?: string;

  constructor(initialState: ShoppingStepState = 'INITIAL') {
    this.currentState = initialState;
    if (initialState === 'SEARCHING') this.currentPhase = 'SEARCH';
    else if (initialState === 'PRODUCT_FOUND' || initialState === 'PRODUCT_SELECTED') this.currentPhase = 'SELECT_PRODUCT';
    else if (initialState === 'CART_UPDATED') this.currentPhase = 'ADD_TO_CART';
    else if (initialState === 'CART_VERIFIED') this.currentPhase = 'VERIFY_CART';
    else if (initialState === 'COMPLETED') this.currentPhase = 'COMPLETED';
    else if (initialState === 'FAILED') this.currentPhase = 'FAILED';
  }

  public getState(): ShoppingStepState {
    return this.currentState;
  }

  public getPhase(): ShoppingWorkflowPhase {
    return this.currentPhase;
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

  public canAdvancePhaseTo(nextPhase: ShoppingWorkflowPhase, reason?: string): boolean {
    if (this.currentPhase === 'COMPLETED' || this.currentPhase === 'FAILED') {
      return false;
    }
    if (nextPhase === 'FAILED') {
      return true;
    }
    const currentOrder = SHOPPING_WORKFLOW_PHASE_ORDER[this.currentPhase];
    const nextOrder = SHOPPING_WORKFLOW_PHASE_ORDER[nextPhase];
    // Progression forward is allowed
    if (nextOrder > currentOrder) {
      return true;
    }
    // Regression backward only allowed with explicit logged reason
    if (nextOrder < currentOrder && Boolean(reason)) {
      return true;
    }
    // Same phase is allowed (idempotent)
    return nextOrder === currentOrder;
  }

  public advancePhase(nextPhase: ShoppingWorkflowPhase, reason?: string): void {
    if (!this.canAdvancePhaseTo(nextPhase, reason)) {
      throw new Error(
        `Illegal shopping phase transition: ${this.currentPhase} -> ${nextPhase}${
          !reason ? ' (regression requires an explicit reason)' : ''
        }`
      );
    }
    const prevPhase = this.currentPhase;
    this.currentPhase = nextPhase;
    this.verifiedPhases.add(prevPhase);

    console.log(
      `[ShoppingWorkflow] phase_transition from=${prevPhase} to=${nextPhase} reason="${reason || 'normal_progression'}" url="${
        this.currentUrl || ''
      }" asin="${this.selectedProduct?.asin || ''}"`
    );
    this.emitTelemetry();
  }

  public setSelectedProduct(product: SelectedShoppingProduct): void {
    this.selectedProduct = product;
    console.log(
      `[ShoppingWorkflow] product_selected asin="${product.asin || ''}" title="${product.title || ''}" price=${
        product.price ?? 0
      } pack_size=${product.packSize ?? 1} url="${product.url || ''}"`
    );
    if (this.currentPhase === 'SEARCH' || this.currentPhase === 'INITIAL') {
      this.advancePhase('SELECT_PRODUCT', 'product_selected');
    }
  }

  public getSelectedProduct(): SelectedShoppingProduct | undefined {
    return this.selectedProduct;
  }

  public setCurrentUrl(url: string): void {
    this.currentUrl = url;
    console.log(`[ShoppingWorkflow] url_tracked url="${url}" phase=${this.currentPhase}`);
  }

  public getCurrentUrl(): string | undefined {
    return this.currentUrl;
  }

  public setVerifiedCart(cart: VerifiedCartSummary): void {
    this.verifiedCart = cart;
    console.log(
      `[ShoppingWorkflow] cart_verified items_count=${cart.itemCount} formatted_total="${cart.formattedTotal || ''}"`
    );
    if (this.currentPhase === 'ADD_TO_CART' || this.currentPhase === 'SELECT_PRODUCT') {
      this.advancePhase('VERIFY_CART', 'cart_verified');
    }
  }

  public getVerifiedCart(): VerifiedCartSummary | undefined {
    return this.verifiedCart;
  }

  public setScreenshotDelivered(mediaId?: string): void {
    this.screenshotDelivered = true;
    this.screenshotMediaId = mediaId;
    console.log(`[ShoppingWorkflow] screenshot_delivered media_id="${mediaId || 'none'}" phase=DELIVER_SCREENSHOT`);
    if (this.currentPhase !== 'COMPLETED' && this.currentPhase !== 'FAILED') {
      this.advancePhase('DELIVER_SCREENSHOT', 'screenshot_delivered');
    }
  }

  public isScreenshotDelivered(): boolean {
    return this.screenshotDelivered;
  }

  public emitTelemetry(): void {
    console.log(
      `[ShoppingWorkflow] telemetry phase=${this.currentPhase} url="${this.currentUrl || ''}" asin="${
        this.selectedProduct?.asin || ''
      }" pack_size=${this.selectedProduct?.packSize ?? 1} price=${this.selectedProduct?.price ?? 0}`
    );
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
    this.currentPhase = 'FAILED';
  }

  public isProductQualified(product: {
    asin?: string;
    title: string;
    price?: number;
    packSize?: number;
  }): boolean {
    const titleLower = product.title.toLowerCase();
    const isIphone16ProMax =
      titleLower.includes('iphone 16 pro max') ||
      (titleLower.includes('16 pro max') && titleLower.includes('iphone')) ||
      (titleLower.includes('iphone 16') && titleLower.includes('pro max'));
    const isScreenGuard =
      titleLower.includes('screen') ||
      titleLower.includes('guard') ||
      titleLower.includes('tempered') ||
      titleLower.includes('glass') ||
      titleLower.includes('protector');
    const packSize =
      product.packSize ??
      (titleLower.match(/(\d+)\s*(?:[- ]?pack|pcs|piece|pieces|units?|count|set)\b/i)
        ? parseInt(titleLower.match(/(\d+)\s*(?:[- ]?pack|pcs|piece|pieces|units?|count|set)\b/i)![1], 10)
        : 1);
    const has3Pack = packSize >= 3 || /3[- ]?pack|pack of 3|set of 3|3 pcs|3 pieces/i.test(titleLower);
    const priceUnder1500 = product.price !== undefined ? product.price <= 1500 : true;

    return isIphone16ProMax && isScreenGuard && has3Pack && priceUnder1500;
  }

  public getFailureReason(): string | undefined {
    return this.failedVerificationReason;
  }
}
