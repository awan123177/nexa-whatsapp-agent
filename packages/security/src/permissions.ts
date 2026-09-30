import { ToolRiskLevel, UserRole, SecurityViolationError } from '@nexa/shared';

// Risk matrix defining which roles can invoke which risk levels
const ROLE_PERMITTED_RISKS: Record<UserRole, Set<ToolRiskLevel>> = {
  admin: new Set(['read_only', 'low_risk', 'medium_risk', 'high_risk', 'critical']),
  user: new Set(['read_only', 'low_risk', 'medium_risk', 'high_risk']),
  tester: new Set(['read_only', 'low_risk', 'medium_risk']),
};

export class PermissionEngine {
  /**
   * Asserts whether a user has permission to execute a tool with a given risk level.
   */
  public static validateToolAccess(toolName: string, riskLevel: ToolRiskLevel, userRole: UserRole): void {
    const permitted = ROLE_PERMITTED_RISKS[userRole] || ROLE_PERMITTED_RISKS.user;
    if (!permitted.has(riskLevel)) {
      throw new SecurityViolationError(
        `User with role '${userRole}' is not authorized to execute tool '${toolName}' (Risk level: ${riskLevel}).`
      );
    }
  }

  /**
   * Checks whether an action must require explicit human confirmation.
   * High-risk and critical tools, or tools performing purchases/transfers/irreversible changes.
   */
  public static isHighRisk(riskLevel: ToolRiskLevel): boolean {
    return riskLevel === 'high_risk' || riskLevel === 'critical';
  }

  /**
   * Asserts that a target resource/URL is permitted to be accessed or screenshotted.
   * Prohibits internal IP ranges, metadata endpoints, and local files.
   */
  public static validateResourceAccess(targetUrl: string): void {
    if (!targetUrl || typeof targetUrl !== 'string') {
      throw new SecurityViolationError('Target resource URL must be a valid non-empty string.');
    }
    const lower = targetUrl.toLowerCase().trim();
    if (
      lower.startsWith('file:') ||
      lower.startsWith('ftp:') ||
      lower.startsWith('javascript:') ||
      lower.startsWith('data:')
    ) {
      throw new SecurityViolationError(`Access to protocol in '${targetUrl}' is prohibited.`);
    }

    try {
      const parsed = new URL(lower.startsWith('http://') || lower.startsWith('https://') ? lower : `https://${lower}`);
      const hostname = parsed.hostname;
      const blockedHosts = [
        'localhost',
        '127.0.0.1',
        '0.0.0.0',
        '169.254.169.254',
        'metadata.google.internal',
        '::1',
      ];
      for (const blocked of blockedHosts) {
        if (hostname === blocked || hostname.startsWith(blocked)) {
          throw new SecurityViolationError(`Access to internal/private resource '${hostname}' is prohibited.`);
        }
      }
      if (
        hostname.startsWith('127.') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('169.254.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
      ) {
        throw new SecurityViolationError(`Access to internal/private resource '${hostname}' is prohibited.`);
      }
    } catch (err: any) {
      if (err instanceof SecurityViolationError) throw err;
      throw new SecurityViolationError(`Invalid resource URL: ${targetUrl}`);
    }
  }
}
