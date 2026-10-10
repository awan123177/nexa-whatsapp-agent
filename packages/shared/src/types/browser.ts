export type AuthState =
  | 'AUTH_NOT_REQUIRED'
  | 'AUTH_REQUIRED'
  | 'AUTHENTICATING'
  | 'WAITING_FOR_USER_AUTH'
  | 'AUTHENTICATED'
  | 'AUTH_EXPIRED'
  | 'AUTH_FAILED'
  | 'CAPTCHA_REQUIRED'
  | 'BLOCKED'
  | 'ERROR';

export type BrowserOpenSuccess = {
  success: true;
  finalUrl: string;
  status: number;
  title: string;
  text: string;
  authState?: AuthState;
};

export type BrowserOpenFailure = {
  success: false;
  errorType: 'TIMEOUT' | 'NAVIGATION_FAILED' | 'BOT_BLOCKED' | 'CAPTCHA_REQUIRED' | 'SECURITY_BLOCKED' | 'INVALID_URL' | 'AUTH_REQUIRED' | 'BLOCKED';
  message: string;
  status?: number;
  authState?: AuthState;
  challengeDetected?: boolean;
  challengeType?: string;
};

export type BrowserOpenResult = BrowserOpenSuccess | BrowserOpenFailure;

export interface CartItem {
  id?: string;
  name: string;
  priceMinor?: number;
  formattedPrice?: string;
  quantity: number;
  url?: string;
}

export interface BrowserCartState {
  items: CartItem[];
  totalPriceMinor?: number;
  formattedTotal?: string;
  currency?: string;
  lastVerifiedAt?: number;
}

export interface ComputerUseActionRecord {
  action:
    | 'navigate'
    | 'click'
    | 'type'
    | 'fill'
    | 'press'
    | 'select'
    | 'scroll'
    | 'hover'
    | 'wait'
    | 'inspect'
    | 'screenshot'
    | 'verify_cart'
    | 'restore';
  target?: string;
  timestamp: number;
  success: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export interface BrowserSessionMetadata {
  id: string;
  sessionId?: string;
  userId?: string;
  merchant?: string;
  activeUrl?: string;
  title?: string;
  lastAction?: string;
  lastActionTimestamp?: number;
  cartState?: BrowserCartState;
  pageState?: 'idle' | 'navigating' | 'authenticating' | 'challenged' | 'error';
  authState?: AuthState;
  browserProfileReference?: string;
  challengeDetected?: boolean;
  challengeType?: string;
  createdAt: number;
  lastActiveAt: number;
  actionHistory: ComputerUseActionRecord[];
}

export interface MerchantSessionRecord {
  id: string;
  userId: string;
  merchant: string;
  authState: AuthState;
  sessionState: Record<string, unknown>;
  browserProfileReference?: string;
  lastVerifiedAt: string;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type SemanticTargetType =
  | 'search_box'
  | 'add_to_cart'
  | 'checkout'
  | 'address'
  | 'quantity_increase'
  | 'quantity_decrease'
  | 'product_item'
  | 'login'
  | 'cart_icon'
  | 'custom';

export interface ResolvedTarget {
  selector: string;
  confidence: number;
  targetType: SemanticTargetType;
  description: string;
  role?: string;
  name?: string;
  text?: string;
  coordinates?: { x: number; y: number };
  matchedBy: 'id' | 'role' | 'placeholder' | 'aria' | 'text' | 'css' | 'heuristics' | 'coordinates' | 'name';
}

export interface PageObservationProduct {
  title: string;
  price?: string;
  rawPrice?: number;
  selector?: string;
  url?: string;
  href?: string;
  asin?: string;
  packSize?: number;
}

export interface PageObservation {
  url: string;
  title: string;
  textSummary: string;
  searchInputs: ResolvedTarget[];
  actionButtons: ResolvedTarget[];
  products: PageObservationProduct[];
  cartSummary?: { itemCount: number; totalText?: string };
  authState?: AuthState;
  challengeDetected?: boolean;
  challengeType?: string;
  isProductDetailPage?: boolean;
  currentAsin?: string;
}

export interface ShoppingProduct {
  title: string;
  store: string;
  price?: number;
  currency?: string;
  url: string;
  snippet?: string;
  selector?: string;
  inStock?: boolean;
  asin?: string;
  packSize?: number;
}
