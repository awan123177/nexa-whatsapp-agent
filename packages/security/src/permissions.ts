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
}
