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

