export type AuthState =
  | 'AUTH_NOT_REQUIRED'
  | 'AUTH_REQUIRED'
  | 'WAITING_FOR_USER_AUTH'
  | 'AUTHENTICATED'
  | 'AUTH_FAILED'
  | 'CAPTCHA_REQUIRED'
  | 'BLOCKED';

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
  authState?: AuthState;
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
  action: 'navigate' | 'click' | 'type' | 'scroll' | 'wait' | 'screenshot' | 'verify_cart' | 'restore';
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
  activeUrl?: string;
  title?: string;
  lastAction?: string;
  lastActionTimestamp?: number;
  cartState?: BrowserCartState;
  pageState?: 'idle' | 'navigating' | 'authenticating' | 'challenged' | 'error';
  challengeDetected?: boolean;
  challengeType?: string;
  createdAt: number;
  lastActiveAt: number;
  actionHistory: ComputerUseActionRecord[];
}


