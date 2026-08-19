import {z} from 'zod';

export const SETTLED_STATUSES = ['idle', 'done'] as const;
export const AGENT_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const TriggerSchema = z.enum([
  'agent_settled',
  'workspace_settled',
  'agent_blocked',
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const ActionSchema = z.enum(['auto', 'confirm', 'notify']);
export type RuleAction = z.infer<typeof ActionSchema>;

const MatchSchema = z
  .object({
    agents: z.array(z.string().min(1)).optional(),
    workspaces: z.array(z.string().min(1)).optional(),
    cwd: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .default({});

const RepeatSchema = z
  .object({
    maxRunsPerSession: z.number().int().positive().default(1),
    cooldownMs: z.number().int().nonnegative().default(0),
  })
  .strict();

export const RuleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    enabled: z.boolean().default(true),
    trigger: TriggerSchema,
    match: MatchSchema,
    action: ActionSchema,
    target: z.string().min(1).optional(),
    prompt: z.string().min(1).max(32_000),
    repeat: RepeatSchema.optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.trigger === 'workspace_settled' && !rule.target) {
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'workspace_settled rules require a unique Herdr agent target',
      });
    }
    if (rule.trigger === 'agent_blocked' && rule.action === 'auto') {
      context.addIssue({
        code: 'custom',
        path: ['action'],
        message: 'agent_blocked rules cannot send prompts automatically',
      });
    }
    const variables = [...rule.prompt.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(
      (match) => match[1],
    );
    for (const variable of variables) {
      if (variable && !TEMPLATE_VARIABLES.includes(variable as TemplateVariable)) {
        context.addIssue({
          code: 'custom',
          path: ['prompt'],
          message: `unknown template variable: ${variable}`,
        });
      }
    }
  });

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    defaults: z
      .object({
        settleMs: z.number().int().min(0).max(60_000).default(2_000),
        pendingTtlMs: z.number().int().positive().default(86_400_000),
        repeat: RepeatSchema.default({maxRunsPerSession: 1, cooldownMs: 0}),
      })
      .strict()
      .default({
        settleMs: 2_000,
        pendingTtlMs: 86_400_000,
        repeat: {maxRunsPerSession: 1, cooldownMs: 0},
      }),
    rules: z.array(RuleSchema).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    for (const [index, rule] of config.rules.entries()) {
      if (seen.has(rule.id)) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'id'],
          message: `duplicate rule id: ${rule.id}`,
        });
      }
      seen.add(rule.id);
    }
  });

export type PromptBucketConfig = z.infer<typeof ConfigSchema>;
export type PromptRule = z.infer<typeof RuleSchema>;

export const TEMPLATE_VARIABLES = [
  'agent',
  'pane_id',
  'workspace_id',
  'workspace',
  'cwd',
  'status',
  'trigger',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateContext = Record<TemplateVariable, string>;

export interface AgentInfo {
  agent: string;
  agent_status: AgentStatus;
  cwd: string;
  pane_id: string;
  revision: number;
  state_change_seq: number;
  tab_id: string;
  terminal_id: string;
  workspace_id: string;
  agent_session?: {
    source: string;
    agent: string;
    kind: string;
    value: string;
  };
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string;
}

export interface RuntimeSnapshot {
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
}

export type QueueStatus =
  | 'ready'
  | 'awaiting_confirmation'
  | 'approved_waiting'
  | 'dispatching'
  | 'in_flight'
  | 'paused';

export interface QueueItem {
  id: string;
  ruleId: string;
  ruleIndex: number;
  targetKey: string;
  targetPaneId: string;
  sessionKey: string;
  workspaceId: string;
  prompt: string;
  action: RuleAction;
  trigger: Trigger;
  triggerSeq: number;
  status: QueueStatus;
  createdAt: number;
  expiresAt: number;
  error?: string;
}

export interface Observation {
  paneId: string;
  workspaceId: string;
  status: AgentStatus;
  stateChangeSeq: number;
  sessionKey: string;
}

export interface WorkspaceObservation {
  allSettled: boolean;
  signature: string;
}

export interface RunRecord {
  count: number;
  lastRunAt: number;
}

export interface HistoryEntry {
  id: string;
  at: number;
  ruleId: string;
  targetKey: string;
  outcome:
    | 'notified'
    | 'queued'
    | 'approved'
    | 'rejected'
    | 'dispatched'
    | 'completed'
    | 'paused'
    | 'expired';
  detail?: string;
}

export interface RuntimeState {
  version: 1;
  observations: Record<string, Observation>;
  workspaces: Record<string, WorkspaceObservation>;
  queue: QueueItem[];
  runs: Record<string, RunRecord>;
  handledTransitions: string[];
  history: HistoryEntry[];
}

export const emptyRuntimeState = (): RuntimeState => ({
  version: 1,
  observations: {},
  workspaces: {},
  queue: [],
  runs: {},
  handledTransitions: [],
  history: [],
});

export const isSettled = (status: AgentStatus): boolean =>
  SETTLED_STATUSES.includes(status as (typeof SETTLED_STATUSES)[number]);

export const sessionKeyFor = (agent: AgentInfo): string =>
  agent.agent_session
    ? `${agent.agent_session.source}:${agent.agent_session.kind}:${agent.agent_session.value}`
    : `${agent.terminal_id}:${agent.agent}`;
