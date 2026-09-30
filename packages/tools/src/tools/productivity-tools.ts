import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult } from '@nexa/shared';
import { IDatabaseRepository } from '@nexa/database';

export function createProductivityTools(db?: IDatabaseRepository): BaseTool[] {
  const getCalendarEventsTool: BaseTool = {
    name: 'get_calendar_events',
    description: 'Retrieves upcoming calendar appointments and scheduled events.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      startDate: z.string().describe('Start date in YYYY-MM-DD format'),
      endDate: z.string().optional().describe('End date in YYYY-MM-DD format'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (_args: any, _context: ToolExecutionContext): Promise<ToolResult> => {
      return {
        success: true,
        data: {
          events: [],
          status: 'disconnected',
          notice: 'Google/Outlook Calendar is not yet connected. Connect your calendar in account settings.',
        },
        userFacingMessage: 'Your calendar account is not connected yet.',
      };
    },
  };

  const createCalendarEventTool: BaseTool = {
    name: 'create_calendar_event',
    description: 'Schedules a new meeting or event on the user calendar. Requires approval before scheduling.',
    riskLevel: 'medium_risk',
    parametersSchema: z.object({
      title: z.string().describe('Meeting or event title'),
      startTime: z.string().describe('ISO 8601 string or date time'),
      endTime: z.string().describe('ISO 8601 string or date time'),
      description: z.string().optional().describe('Event description or notes'),
      attendees: z.array(z.string().email()).optional().describe('List of attendee email addresses'),
    }),
    requiresApproval: (args) => ({
      required: true,
      impactLevel: 'medium',
      reason: 'Creating a calendar event may invite attendees and modify user schedule.',
      formatConfirmationPrompt: () =>
        `I will schedule "*${args.title}*" from ${args.startTime} to ${args.endTime}${(args as any).attendees ? ` inviting: ${(args as any).attendees.join(', ')}` : ''}. Would you like me to proceed?`,
    }),
    execute: async (args: any, _context: ToolExecutionContext): Promise<ToolResult> => {
      return {
        success: false,
        error: 'Calendar provider not connected.',
        userFacingMessage: 'Cannot add to calendar: Calendar account is not connected yet.',
      };
    },
  };

  const createReminderTool: BaseTool = {
    name: 'create_reminder',
    description: 'Sets a reminder or scheduled task for the user.',
    riskLevel: 'low_risk',
    parametersSchema: z.object({
      title: z.string().describe('The reminder text or task summary'),
      remindAt: z.string().describe('ISO 8601 timestamp or natural date when the reminder should trigger'),
      notes: z.string().optional().describe('Additional notes or details'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { title: string; remindAt: string; notes?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      let task = null;
      if (db) {
        task = await db.createTask({
          user_id: context.user.id,
          title: args.title,
          description: args.notes || null,
          status: 'pending',
          next_run_at: new Date(args.remindAt).toISOString(),
          metadata: {
            source: 'agent_reminder_tool',
            channel: context.sourceChannel,
          },
        });
      }

      return {
        success: true,
        data: {
          task,
          title: args.title,
          scheduledFor: args.remindAt,
        },
        userFacingMessage: `Reminder set: "${args.title}" for ${args.remindAt}.`,
      };
    },
  };

  return [getCalendarEventsTool, createCalendarEventTool, createReminderTool];
}
