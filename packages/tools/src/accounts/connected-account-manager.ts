import {
  ConnectedAccount,
  AuthState,
  MerchantSessionRecord,
} from '@nexa/shared';
import { IDatabaseRepository } from '@nexa/database';
import { CredentialVault, credentialVault } from '@nexa/security';

export interface ConnectAccountOptions {
  userId: string;
  merchant: string;
  accountId: string;
  scopes?: string[];
  credentials?: Record<string, unknown>; // Will be encrypted before storage
  metadata?: Record<string, unknown>;
}

export class ConnectedAccountManager {
  constructor(
    private db: IDatabaseRepository,
    private vault: CredentialVault = credentialVault
  ) {}

  /**
   * Checks whether a user has a connected account for the specified merchant.
   * Telemetry: logs connection_lookup (never logs passwords or secrets).
   */
  async hasConnectedAccount(userId: string, merchant: string): Promise<boolean> {
    console.log(`[Account] connection_lookup user=${userId} merchant=${merchant}`);
    const account = await this.db.getConnectedAccount(userId, merchant.toLowerCase());
    return Boolean(account && account.status === 'active');
  }

  /**
   * Retrieves the connected account for a user and merchant.
   */
  async getConnectedAccount(userId: string, merchant: string): Promise<ConnectedAccount | null> {
    console.log(`[Account] connection_lookup user=${userId} merchant=${merchant}`);
    const account = await this.db.getConnectedAccount(userId, merchant.toLowerCase());
    if (!account) return null;
    return account;
  }

  /**
   * Retrieves decrypted credentials strictly in-memory at execution time.
   * NEVER log or expose the returned object!
   */
  async getDecryptedCredentials<T = Record<string, unknown>>(
    userId: string,
    merchant: string
  ): Promise<T | null> {
    const account = await this.getConnectedAccount(userId, merchant);
    if (!account || !account.token_data) return null;
    return this.vault.decryptCredentials<T>(userId, merchant, account.token_data);
  }

  /**
   * Connects or updates a merchant account for a user, securely encrypting all credentials.
   */
  async connectAccount(options: ConnectAccountOptions): Promise<ConnectedAccount> {
    const { userId, merchant, accountId, scopes = [], credentials = {}, metadata = {} } = options;
    const cleanMerchant = merchant.toLowerCase();

    // Encrypt credentials using per-user context-bound encryption
    const encryptedTokenData = this.vault.encryptCredentials(userId, cleanMerchant, credentials);

    const saved = await this.db.saveConnectedAccount({
      user_id: userId,
      provider: cleanMerchant,
      account_id: accountId,
      scopes,
      token_data: encryptedTokenData,
      status: 'active',
      metadata,
    });

    console.log(`[Account] account_connected user=${userId} merchant=${merchant}`);
    return saved;
  }

  /**
   * Gets or checks the active authenticated browser session for a user + merchant.
   */
  async getSessionState(userId: string, merchant: string): Promise<MerchantSessionRecord | null> {
    const session = await this.db.getMerchantSession(userId, merchant);
    if (!session) {
      console.log(`[Account] authentication_required merchant=${merchant}`);
      return null;
    }

    if (session.authState === 'AUTH_EXPIRED') {
      console.log(`[Account] session_expired merchant=${merchant}`);
      return session;
    }

    if (session.authState === 'AUTHENTICATED') {
      console.log(`[Account] session_restored merchant=${merchant}`);
    }

    return session;
  }

  /**
   * Updates or saves the merchant session state.
   */
  async updateSessionState(
    userId: string,
    merchant: string,
    authState: AuthState,
    sessionState: Record<string, unknown> = {},
    browserProfileReference?: string
  ): Promise<MerchantSessionRecord> {
    const now = new Date().toISOString();
    return this.db.saveMerchantSession({
      userId,
      merchant,
      authState,
      sessionState,
      browserProfileReference,
      lastVerifiedAt: now,
      lastUsedAt: now,
    });
  }

  /**
   * Marks session as expired.
   */
  async markSessionExpired(userId: string, merchant: string): Promise<MerchantSessionRecord> {
    console.log(`[Account] session_expired merchant=${merchant}`);
    return this.updateSessionState(userId, merchant, 'AUTH_EXPIRED');
  }

  /**
   * Disconnects / revokes an account.
   */
  async disconnectAccount(userId: string, merchant: string): Promise<boolean> {
    const cleanMerchant = merchant.toLowerCase();
    await this.db.updateConnectedAccountStatus(userId, cleanMerchant, 'revoked');
    await this.updateSessionState(userId, merchant, 'AUTH_REQUIRED');
    return true;
  }
}
