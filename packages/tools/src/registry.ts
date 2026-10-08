import { z } from 'zod';
import {
  BaseTool,
  ToolExecutionContext,
  ToolResult,
  AIToolDeclaration,
  ApprovalRequiredError,
  ToolExecutionError,
} from '@nexa/shared';
import { PermissionEngine, createAuditLogEntry } from '@nexa/security';
import { IDatabaseRepository } from '@nexa/database';

export class ToolRegistry {
  private tools = new Map<string, BaseTool<any, any>>();
  private db?: IDatabaseRepository;

  constructor(options: { db?: IDatabaseRepository } = {}) {
    this.db = options.db;
  }

  public setDatabase(db: IDatabaseRepository): void {
    this.db = db;
  }

  public register(tool: BaseTool<any, any>): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Overwriting existing tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  public getTool(name: string): BaseTool<any, any> | undefined {
    return this.tools.get(name);
  }

  public getAllTools(): BaseTool<any, any>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Translates registered tools into AI tool declarations (JSON schema)
   * compatible with Gemini and other LLM function calling schemas.
   */
  public getDeclarations(): AIToolDeclaration[] {
    const declarations: AIToolDeclaration[] = [];

    for (const tool of this.tools.values()) {
      const jsonSchema = this.zodToJsonSchema(tool.parametersSchema);
      declarations.push({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: jsonSchema.properties || {},
          required: jsonSchema.required || [],
        },
      });
    }

    return declarations;
  }

  /**
   * Executes a tool with input validation, role permissions, approval requirements,
   * error handling, and audit logging.
   */
  async executeTool(
    name: string,
    rawArgs: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolExecutionError(name, `Tool '${name}' is not registered in NEXA.`);
    }

    const startTime = Date.now();

    // 1. Validate role permissions
    PermissionEngine.validateToolAccess(tool.name, tool.riskLevel, context.user.role);

    // 2. Validate arguments against schema
    let parsedArgs: any;
    try {
      parsedArgs = tool.parametersSchema.parse(rawArgs);
    } catch (err: any) {
      const zErr = err instanceof z.ZodError ? err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ') : err.message;
      throw new ToolExecutionError(tool.name, `Invalid tool arguments: ${zErr}`);
    }

    // 3. Check if explicit user approval is required
    const approvalCheck = await tool.requiresApproval(parsedArgs, context);
    if (approvalCheck.required && !context.isUserConfirmed) {
      const prompt = approvalCheck.formatConfirmationPrompt
        ? approvalCheck.formatConfirmationPrompt(parsedArgs, context)
        : `NEXA is ready to execute '${tool.name}'. This action may be consequential. Do you want to proceed? (Reply 'Yes' to confirm or 'No' to cancel)`;

      // If database is available, create a pending approval record
      let approvalId = `approval_${Date.now()}`;
      if (this.db) {
        const approvalRecord = await this.db.createApproval({
          conversation_id: context.conversation.id,
          user_id: context.user.id,
          tool_name: tool.name,
          arguments: parsedArgs,
          summary: prompt,
          impact_level: approvalCheck.impactLevel || 'high',
          status: 'pending',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          metadata: {
            reason: approvalCheck.reason || 'Consequential action requiring human consent',
          },
        });
        approvalId = approvalRecord.id;
      }

      throw new ApprovalRequiredError({
        approvalId,
        toolName: tool.name,
        toolArguments: parsedArgs,
        prompt,
      });
    }

    // 4. Execute tool
    let result: ToolResult;
    let executionError: string | undefined;

    try {
      result = await tool.execute(parsedArgs, context);
    } catch (err: any) {
      if (err instanceof ApprovalRequiredError || err?.name === 'ApprovalRequiredError') {
        throw err;
      }
      executionError = err.message || 'Unknown error during execution';
      result = {
        success: false,
        error: executionError,
        userFacingMessage: err.userFacingMessage || `Failed to execute ${tool.name}: ${executionError}`,
      };
    }

    const durationMs = Date.now() - startTime;

    // 5. Persist audit log and tool call record
    if (this.db) {
      await this.db.saveToolCall({
        conversation_id: context.conversation.id,
        message_id: context.messageId,
        tool_name: tool.name,
        arguments: parsedArgs,
        result: (result.data as Record<string, unknown>) || undefined,
        status: result.success ? 'success' : 'failed',
        duration_ms: durationMs,
        error: executionError,
      }).catch((e) => console.error('[ToolRegistry] Failed to save tool call:', e));

      await this.db.saveAuditLog(
        createAuditLogEntry({
          userId: context.user.id,
          action: `execute_tool:${tool.name}`,
          resource: 'tool_registry',
          details: {
            arguments: parsedArgs,
            success: result.success,
            durationMs,
          },
          status: result.success ? 'success' : 'failure',
        })
      ).catch((e) => console.error('[ToolRegistry] Failed to save audit log:', e));
    }

    return result;
  }

  /**
   * Helper to convert basic Zod schemas into JSON Schema for Gemini
   */
  private zodToJsonSchema(schema: z.ZodType<any>): {
    properties: Record<string, unknown>;
    required: string[];
  } {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    if (schema instanceof z.ZodObject) {
      const shape = schema.shape;
      for (const [key, value] of Object.entries(shape)) {
        const zodProp = value as z.ZodTypeAny;
        let isOptional = false;
        let unwrapped = zodProp;

        if (unwrapped instanceof z.ZodOptional) {
          isOptional = true;
          unwrapped = unwrapped.unwrap();
        }

        if (!isOptional) {
          required.push(key);
        }

        properties[key] = this.zodTypeToJsonType(unwrapped);
      }
    }

    return { properties, required };
  }

  private zodTypeToJsonType(zodType: z.ZodTypeAny): Record<string, unknown> {
    if (zodType instanceof z.ZodString) {
      return { type: 'string', description: zodType.description || '' };
    }
    if (zodType instanceof z.ZodNumber) {
      return { type: 'number', description: zodType.description || '' };
    }
    if (zodType instanceof z.ZodBoolean) {
      return { type: 'boolean', description: zodType.description || '' };
    }
    if (zodType instanceof z.ZodArray) {
      return {
        type: 'array',
        items: this.zodTypeToJsonType((zodType as any).element),
      };
    }
    if (zodType instanceof z.ZodEnum) {
      return {
        type: 'string',
        enum: (zodType as any)._def.values,
      };
    }
    if (zodType instanceof z.ZodObject) {
      const inner = this.zodToJsonSchema(zodType);
      return {
        type: 'object',
        properties: inner.properties,
        required: inner.required,
      };
    }
    return { type: 'string' };
  }
}
