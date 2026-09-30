import { AuditLog } from '@nexa/shared';
import { redactObject } from './redactor.js';

export function createAuditLogEntry(params: {
  userId?: string | null;
  action: string;
  resource: string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
  status?: 'success' | 'failure';
}): Omit<AuditLog, 'id' | 'created_at'> {
  return {
    user_id: params.userId || null,
    action: params.action,
    resource: params.resource,
    details: redactObject(params.details || {}),
    ip_address: params.ipAddress || null,
    status: params.status || 'success',
  };
}
