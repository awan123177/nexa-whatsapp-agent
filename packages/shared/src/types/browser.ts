export type BrowserOpenSuccess = {
  success: true;
  finalUrl: string;
  status: number;
  title: string;
  text: string;
};

export type BrowserOpenFailure = {
  success: false;
  errorType: 'TIMEOUT' | 'NAVIGATION_FAILED' | 'BOT_BLOCKED' | 'SECURITY_BLOCKED' | 'INVALID_URL';
  message: string;
};

export type BrowserOpenResult = BrowserOpenSuccess | BrowserOpenFailure;
