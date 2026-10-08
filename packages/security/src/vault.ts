import { encryptTokenData, decryptTokenData } from './encryption.js';

export interface MerchantCredentials {
  username?: string;
  phone?: string;
  email?: string;
  password?: string;
  sessionToken?: string;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>;
  apiKey?: string;
  [key: string]: unknown;
}

/**
 * Secure Credential Vault for connected merchant accounts.
 * - Stores credentials encrypted using AES-256-GCM.
 * - Encrypts and decrypts only in-memory at execution time.
 * - Enforces per-user separation (each record bound to specific userId + merchant).
 * - Guarantees zero credential logging and zero credential leakage.
 */
export class CredentialVault {
  private secretKey?: string;

  constructor(secretKey?: string) {
    this.secretKey = secretKey || process.env.ENCRYPTION_KEY;
  }

  /**
   * Generates a context-bound salt from userId and merchant so credentials
   * cannot be used across different users or merchants.
   */
  private getContextSecret(userId: string, merchant: string): string {
    const base = this.secretKey || process.env.ENCRYPTION_KEY || 'nexa-default-vault-key-for-local-dev';
    return `${base}:${userId}:${merchant.toLowerCase().trim()}`;
  }

  /**
   * Encrypts merchant credentials payload for persistent storage.
   */
  public encryptCredentials(
    userId: string,
    merchant: string,
    credentials: Record<string, unknown>
  ): Record<string, unknown> {
    if (!credentials || typeof credentials !== 'object') {
      return {};
    }
    const contextSecret = this.getContextSecret(userId, merchant);
    return encryptTokenData(credentials, contextSecret);
  }

  /**
   * Decrypts merchant credentials strictly in-memory at execution time.
   * NEVER write the returned object to logs, prompts, or WhatsApp messages.
   */
  public decryptCredentials<T = MerchantCredentials>(
    userId: string,
    merchant: string,
    encryptedData: Record<string, unknown>
  ): T {
    if (!encryptedData || typeof encryptedData !== 'object') {
      return {} as T;
    }
    const contextSecret = this.getContextSecret(userId, merchant);
    return decryptTokenData(encryptedData, contextSecret) as T;
  }
}

export const credentialVault = new CredentialVault();
