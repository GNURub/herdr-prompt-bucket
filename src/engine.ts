import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {minimatch} from 'minimatch';
import type {HerdrClient} from './herdr.js';
import {
  isSettled,
  sessionKeyFor,
  type AgentInfo,
  type AgentStatus,
  type HistoryEntry,
  type PromptBucketConfig,
  type PromptRule,
  type QueueItem,
  type RuntimeSnapshot,
  type RuntimeState,
  type TemplateContext,
  type Trigger,
  type WorkspaceInfo,
} from './model.js';
import {PluginStorage} from './storage.js';
import {renderTemplate} from './template.js';

interface PluginEvent {
  type: string;
  pane_id?: string;
  agent_status?: AgentStatus | null;
}

interface PluginEventEnvelope {
  event?: string;
  data?: PluginEvent;
}

export const normalizePluginEvent = (rawEvent: string): PluginEvent => {
  const parsed = JSON.parse(rawEvent) as PluginEvent | PluginEventEnvelope;
  const event = 'data' in parsed && parsed.data ? parsed.data : (parsed as PluginEvent);
  const rawType = ('event' in parsed && parsed.event) || event.type;
  const type =
    rawType === 'pane_agent_status_changed'
      ? 'pane.agent_status_changed'
      : rawType === 'pane_closed'
        ? 'pane.closed'
        : rawType;
  return {...event, type};
};

interface TriggerContext {
  trigger: Trigger;
  sourceAgent: AgentInfo;
  workspace: WorkspaceInfo;
}

interface EnqueueCandidate {
  rule: PromptRule;
  ruleIndex: number;
  trigger: Trigger;
  sourceAgent: AgentInfo;
  targetAgent: AgentInfo;
  workspace: WorkspaceInfo;
  prompt: string;
}

const transitionId = (context: TriggerContext): string =>
  context.trigger === 'workspace_settled'
    ? `workspace:${context.workspace.workspace_id}:${workspaceSignatureForAgent(context.sourceAgent)}`
    : `${context.trigger}:${context.sourceAgent.terminal_id}:${context.sourceAgent.state_change_seq}`;

const workspaceSignatureForAgent = (agent: AgentInfo): string =>
  `${agent.workspace_id}:${agent.state_change_seq}`;

export const workspaceSignature = (agents: AgentInfo[]): string =>
  agents
    .map((agent) => `${agent.terminal_id}:${agent.agent_status}:${agent.state_change_seq}`)
    .sort()
    .join('|');

const historyEntry = (
  ruleId: string,
  targetKey: string,
  outcome: HistoryEntry['outcome'],
  detail?: string,
): HistoryEntry => ({
  id: randomUUID(),
  at: Date.now(),
  ruleId,
  targetKey,
  outcome,
  ...(detail ? {detail} : {}),
});

const matchesAny = (value: string, patterns: string[] | undefined): boolean =>
  !patterns?.length ||
  patterns.some((pattern) =>
    minimatch(value, pattern, {dot: true, nocase: process.platform === 'win32'}),
  );

export const ruleMatches = (
  rule: PromptRule,
  agent: AgentInfo,
  workspace: WorkspaceInfo,
): boolean =>
  matchesAny(agent.agent, rule.match.agents) &&
  matchesAny(agent.pane_id, rule.match.panes) &&
  matchesAny(workspace.label, rule.match.workspaces) &&
  matchesAny(agent.cwd, rule.match.cwd);

const templateContext = (
  trigger: Trigger,
  agent: AgentInfo,
  workspace: WorkspaceInfo,
): TemplateContext => ({
  agent: agent.agent,
  pane_id: agent.pane_id,
  workspace_id: agent.workspace_id,
  workspace: workspace.label,
  cwd: agent.cwd,
  status: agent.agent_status,
  trigger,
});

const pruneExpired = (state: RuntimeState, now: number): void => {
  const active: QueueItem[] = [];
  for (const item of state.queue) {
    if (item.expiresAt <= now && item.status !== 'in_flight') {
      state.history.push(historyEntry(item.ruleId, item.targetKey, 'expired'));
    } else {
      active.push(item);
    }
  }
  state.queue = active;
};

const sessionRunKey = (ruleId: string, sessionKey: string): string => `${ruleId}:${sessionKey}`;

export class PromptBucketEngine {
  constructor(
    readonly storage: PluginStorage,
    readonly herdr: HerdrClient,
    readonly now: () => number = Date.now,
    readonly sleep: (milliseconds: number) => Promise<unknown> = delay,
  ) {}

  async startup(): Promise<void> {
    const [config, snapshot] = await Promise.all([this.storage.loadConfig(), this.herdr.snapshot()]);
    const liveByTerminal = new Map(snapshot.agents.map((agent) => [agent.terminal_id, agent]));
    const targetsToDrain = await this.storage.mutateState((state) => {
      pruneExpired(state, this.now());
      const nextObservations: RuntimeState['observations'] = {};
      for (const agent of snapshot.agents) {
        nextObservations[agent.terminal_id] = {
          paneId: agent.pane_id,
          workspaceId: agent.workspace_id,
          status: agent.agent_status,
          stateChangeSeq: agent.state_change_seq,
          sessionKey: sessionKeyFor(agent),
        };
      }
      state.observations = nextObservations;
      state.workspaces = Object.fromEntries(
        snapshot.workspaces.map((workspace) => {
          const agents = snapshot.agents.filter(
            (agent) => agent.workspace_id === workspace.workspace_id,
          );
          return [
            workspace.workspace_id,
            {
              allSettled: agents.length > 0 && agents.every((agent) => isSettled(agent.agent_status)),
              signature: workspaceSignature(agents),
            },
          ];
        }),
      );

      const drain = new Set<string>();
      for (const item of state.queue) {
        const live = liveByTerminal.get(item.targetKey);
        if (!live || sessionKeyFor(live) !== item.sessionKey) {
          item.status = 'paused';
          item.error = 'The original agent session is no longer available';
          state.history.push(
            historyEntry(item.ruleId, item.targetKey, 'paused', item.error),
          );
          continue;
        }
        item.targetPaneId = live.pane_id;
        if (item.status === 'dispatching') {
          item.status = 'paused';
          item.error = 'Delivery was interrupted; review and retry explicitly';
        } else if (item.status === 'in_flight' && isSettled(live.agent_status)) {
          state.history.push(historyEntry(item.ruleId, item.targetKey, 'completed'));
          item.status = 'ready';
          state.queue = state.queue.filter((queued) => queued.id !== item.id);
          drain.add(item.targetKey);
        } else if (
          isSettled(live.agent_status) &&
          (item.status === 'ready' || item.status === 'approved_waiting')
        ) {
          drain.add(item.targetKey);
        }
      }
      return [...drain];
    });

    if (config.defaults.settleMs > 0 && targetsToDrain.length > 0) {
      await this.sleep(config.defaults.settleMs);
    }
    for (const target of targetsToDrain) await this.drainTarget(target);
    await this.refreshPendingMetadata();
  }

  async handleEvent(rawEvent: string): Promise<void> {
    const config = await this.storage.loadConfig();
    const event = normalizePluginEvent(rawEvent);
    if (event.type === 'pane.closed') {
      await this.reconcileClosedPane(event.pane_id);
      return;
    }
    if (event.type !== 'pane.agent_status_changed' || !event.pane_id) return;

    const [agent, snapshot] = await Promise.all([
      this.herdr.getAgent(event.pane_id),
      this.herdr.snapshot(),
    ]);
    if (!agent) {
      await this.reconcileClosedPane(event.pane_id);
      return;
    }
    const workspace = snapshot.workspaces.find(
      (candidate) => candidate.workspace_id === agent.workspace_id,
    );
    if (!workspace) return;

    const workspaceAgents = snapshot.agents.filter(
      (candidate) => candidate.workspace_id === agent.workspace_id,
    );
    const allSettled =
      workspaceAgents.length > 0 &&
      workspaceAgents.every((candidate) => isSettled(candidate.agent_status));
    const signature = workspaceSignature(workspaceAgents);

    const candidates = await this.storage.mutateState((state) => {
      pruneExpired(state, this.now());
      const previous = state.observations[agent.terminal_id];
      const previousWorkspace = state.workspaces[agent.workspace_id];
      state.observations[agent.terminal_id] = {
        paneId: agent.pane_id,
        workspaceId: agent.workspace_id,
        status: agent.agent_status,
        stateChangeSeq: agent.state_change_seq,
        sessionKey: sessionKeyFor(agent),
      };
      state.workspaces[agent.workspace_id] = {allSettled, signature};

      const triggers: TriggerContext[] = [];
      if (
        isSettled(agent.agent_status) &&
        previous &&
        (previous.status === 'working' || previous.status === 'blocked')
      ) {
        triggers.push({trigger: 'agent_settled', sourceAgent: agent, workspace});
      }
      if (agent.agent_status === 'blocked' && previous?.status !== 'blocked') {
        triggers.push({trigger: 'agent_blocked', sourceAgent: agent, workspace});
      }
      if (allSettled && previousWorkspace && !previousWorkspace.allSettled) {
        triggers.push({trigger: 'workspace_settled', sourceAgent: agent, workspace});
      }
      return triggers;
    });

    const needsSettledValidation =
      isSettled(agent.agent_status) ||
      candidates.some((candidate) => candidate.trigger === 'workspace_settled');
    if (needsSettledValidation && config.defaults.settleMs > 0) {
      await this.sleep(config.defaults.settleMs);
    }

    const stableSnapshot = needsSettledValidation ? await this.herdr.snapshot() : snapshot;
    const stableAgent = stableSnapshot.agents.find(
      (candidate) => candidate.terminal_id === agent.terminal_id,
    );
    if (!stableAgent) return;
    const stableWorkspace = stableSnapshot.workspaces.find(
      (candidate) => candidate.workspace_id === stableAgent.workspace_id,
    );
    if (!stableWorkspace) return;

    const validTriggers = candidates.filter((candidate) => {
      if (candidate.trigger === 'agent_blocked') {
        return stableAgent.agent_status === 'blocked';
      }
      if (candidate.trigger === 'agent_settled') {
        return (
          isSettled(stableAgent.agent_status) &&
          stableAgent.state_change_seq === candidate.sourceAgent.state_change_seq
        );
      }
      const agents = stableSnapshot.agents.filter(
        (candidateAgent) => candidateAgent.workspace_id === stableAgent.workspace_id,
      );
      return (
        agents.length > 0 &&
        agents.every((candidateAgent) => isSettled(candidateAgent.agent_status)) &&
        workspaceSignature(agents) === signature
      );
    });

    if (isSettled(stableAgent.agent_status)) {
      await this.completeInflight(stableAgent.terminal_id);
    }
    if (validTriggers.length > 0) {
      await this.evaluateAndEnqueue(validTriggers, stableSnapshot, config);
    }
    if (isSettled(stableAgent.agent_status)) {
      await this.drainTarget(stableAgent.terminal_id);
    }
    await this.drainReadyTargets();
    await this.refreshPendingMetadata();
  }

  private async evaluateAndEnqueue(
    triggers: TriggerContext[],
    snapshot: RuntimeSnapshot,
    config: PromptBucketConfig,
  ): Promise<void> {
    const triggerByType = new Map(triggers.map((context) => [context.trigger, context]));
    const candidates: EnqueueCandidate[] = [];
    const errors: string[] = [];

    for (const [ruleIndex, rule] of config.rules.entries()) {
      if (!rule.enabled) continue;
      const context = triggerByType.get(rule.trigger);
      if (!context) continue;

      let target = context.sourceAgent;
      if (rule.trigger === 'workspace_settled') {
        target = (await this.herdr.getAgent(rule.target!)) ?? target;
        if (target === context.sourceAgent && target.agent !== rule.target) {
          errors.push(`Rule ${rule.id}: coordinator ${rule.target} was not found`);
          continue;
        }
        if (target.workspace_id !== context.workspace.workspace_id) {
          errors.push(`Rule ${rule.id}: coordinator is not in workspace ${context.workspace.label}`);
          continue;
        }
      }
      if (!ruleMatches(rule, target, context.workspace)) continue;

      candidates.push({
        rule,
        ruleIndex,
        trigger: context.trigger,
        sourceAgent: context.sourceAgent,
        targetAgent: target,
        workspace: context.workspace,
        prompt: renderTemplate(rule.prompt, templateContext(context.trigger, target, context.workspace)),
      });
    }

    const notifications = await this.storage.mutateState((state) => {
      const now = this.now();
      pruneExpired(state, now);
      const messages: Array<{title: string; body: string; sound: 'none' | 'request'}> = [];
      for (const context of triggers) {
        const id = transitionId(context);
        if (!state.handledTransitions.includes(id)) state.handledTransitions.push(id);
      }

      for (const candidate of candidates) {
        const id = transitionId({
          trigger: candidate.trigger,
          sourceAgent: candidate.sourceAgent,
          workspace: candidate.workspace,
        });
        const unique = `${id}:${candidate.rule.id}:${candidate.targetAgent.terminal_id}`;
        if (state.handledTransitions.includes(unique)) continue;
        state.handledTransitions.push(unique);

        const sessionKey = sessionKeyFor(candidate.targetAgent);
        const repeat = candidate.rule.repeat ?? config.defaults.repeat;
        const runKey = sessionRunKey(candidate.rule.id, sessionKey);
        const runs = state.runs[runKey];
        const alreadyQueued = state.queue.some(
          (item) => item.ruleId === candidate.rule.id && item.sessionKey === sessionKey,
        );
        if (alreadyQueued || (runs?.count ?? 0) >= repeat.maxRunsPerSession) continue;
        if (runs && now - runs.lastRunAt < repeat.cooldownMs) continue;

        if (candidate.rule.action === 'notify') {
          state.runs[runKey] = {count: (runs?.count ?? 0) + 1, lastRunAt: now};
          state.history.push(
            historyEntry(candidate.rule.id, candidate.targetAgent.terminal_id, 'notified'),
          );
          messages.push({
            title: `Prompt Bucket · ${candidate.rule.id}`,
            body: candidate.prompt,
            sound: candidate.trigger === 'agent_blocked' ? 'request' : 'none',
          });
          continue;
        }

        const item: QueueItem = {
          id: randomUUID(),
          ruleId: candidate.rule.id,
          ruleIndex: candidate.ruleIndex,
          targetKey: candidate.targetAgent.terminal_id,
          targetPaneId: candidate.targetAgent.pane_id,
          sessionKey,
          workspaceId: candidate.targetAgent.workspace_id,
          prompt: candidate.prompt,
          action: candidate.rule.action,
          trigger: candidate.trigger,
          triggerSeq: candidate.sourceAgent.state_change_seq,
          status: candidate.rule.action === 'confirm' ? 'awaiting_confirmation' : 'ready',
          createdAt: now,
          expiresAt: now + config.defaults.pendingTtlMs,
          ...(candidate.rule.oneShot ? {oneShot: true} : {}),
        };
        state.queue.push(item);
        state.history.push(historyEntry(item.ruleId, item.targetKey, 'queued'));
        if (item.status === 'awaiting_confirmation') {
          messages.push({
            title: 'Prompt Bucket confirmation',
            body: `${item.ruleId} is waiting for approval`,
            sound: 'request',
          });
        }
      }
      return messages;
    });

    for (const error of errors) {
      await this.herdr.notify('Prompt Bucket configuration', error, 'request').catch(() => undefined);
    }
    for (const notification of notifications) {
      await this.herdr
        .notify(notification.title, notification.body, notification.sound)
        .catch(() => undefined);
    }
  }

  async enqueueOneShot(
    rule: PromptRule,
    agent: AgentInfo,
  ): Promise<'queued' | 'sent'> {
    const config = await this.storage.loadConfig();
    const now = this.now();
    const item: QueueItem = {
      id: randomUUID(),
      ruleId: rule.id,
      ruleIndex: config.rules.length,
      targetKey: agent.terminal_id,
      targetPaneId: agent.pane_id,
      sessionKey: sessionKeyFor(agent),
      workspaceId: agent.workspace_id,
      prompt: rule.prompt,
      action: 'auto',
      trigger: 'agent_settled',
      triggerSeq: agent.state_change_seq,
      status: 'ready',
      createdAt: now,
      expiresAt: now + config.defaults.pendingTtlMs,
      oneShot: true,
    };

    await this.storage.mutateState((state) => {
      pruneExpired(state, now);
      state.queue.push(item);
      state.history.push(historyEntry(item.ruleId, item.targetKey, 'queued'));
    });
    await this.refreshPendingMetadata();
    await this.drainTarget(agent.terminal_id);
    const state = await this.storage.readState();
    return state.queue.some(
      (candidate) => candidate.id === item.id && candidate.status === 'in_flight',
    )
      ? 'sent'
      : 'queued';
  }

  private async completeInflight(targetKey: string): Promise<void> {
    await this.storage.mutateState((state) => {
      const item = state.queue.find(
        (candidate) => candidate.targetKey === targetKey && candidate.status === 'in_flight',
      );
      if (!item) return;
      state.queue = state.queue.filter((candidate) => candidate.id !== item.id);
      state.history.push(historyEntry(item.ruleId, item.targetKey, 'completed'));
    });
  }

  async drainTarget(targetKey: string): Promise<void> {
    const snapshot = await this.herdr.snapshot();
    const agent = snapshot.agents.find((candidate) => candidate.terminal_id === targetKey);
    if (!agent || !isSettled(agent.agent_status)) return;

    if (agent.agent === 'opencode') {
      const diagnostics = await this.herdr.getAgentDiagnostics(agent.pane_id);
      if (!diagnostics.lifecycleAuthoritative) {
        const message =
          'OpenCode automatic delivery requires lifecycle authority; run `herdr integration install opencode`';
        const paused = await this.storage.mutateState((state) => {
          const first = state.queue.find((candidate) => candidate.targetKey === targetKey);
          if (!first || !['ready', 'approved_waiting'].includes(first.status)) return false;
          first.status = 'paused';
          first.error = message;
          state.history.push(historyEntry(first.ruleId, first.targetKey, 'paused', message));
          return true;
        });
        if (paused) {
          await this.herdr
            .notify('Prompt Bucket paused', message, 'request')
            .catch(() => undefined);
        }
        return;
      }
    }

    const item = await this.storage.mutateState((state) => {
      pruneExpired(state, this.now());
      const first = state.queue.find((candidate) => candidate.targetKey === targetKey);
      if (!first || !['ready', 'approved_waiting'].includes(first.status)) return null;
      if (first.sessionKey !== sessionKeyFor(agent)) {
        first.status = 'paused';
        first.error = 'Agent session changed before delivery';
        state.history.push(historyEntry(first.ruleId, first.targetKey, 'paused', first.error));
        return null;
      }
      first.status = 'dispatching';
      first.targetPaneId = agent.pane_id;
      return {...first};
    });
    if (!item) return;

    try {
      await this.herdr.prompt(agent.pane_id, item.prompt);
      await this.storage.mutateState((state) => {
        const current = state.queue.find((candidate) => candidate.id === item.id);
        if (!current) return;
        current.status = 'in_flight';
        delete current.error;
        const runKey = sessionRunKey(current.ruleId, current.sessionKey);
        const previous = state.runs[runKey];
        state.runs[runKey] = {
          count: (previous?.count ?? 0) + 1,
          lastRunAt: this.now(),
        };
        state.history.push(historyEntry(current.ruleId, current.targetKey, 'dispatched'));
      });
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      await this.storage.mutateState((state) => {
        const current = state.queue.find((candidate) => candidate.id === item.id);
        if (!current) return;
        current.status = 'paused';
        current.error = message;
        state.history.push(historyEntry(current.ruleId, current.targetKey, 'paused', message));
      });
      await this.herdr
        .notify('Prompt Bucket paused', `${item.ruleId}: ${message}`, 'request')
        .catch(() => undefined);
      return;
    }

    if (item.oneShot) {
      await this.storage.removeRule(item.ruleId).catch(async (error: Error) => {
        await this.herdr
          .notify(
            'Prompt Bucket cleanup failed',
            `${item.ruleId} was sent but could not be removed: ${error.message.slice(0, 300)}`,
            'request',
          )
          .catch(() => undefined);
      });
      await this.storage.mutateState((state) => {
        delete state.runs[sessionRunKey(item.ruleId, item.sessionKey)];
      });
    }
  }

  private async drainReadyTargets(): Promise<void> {
    const state = await this.storage.readState();
    const targets = new Set(
      state.queue
        .filter((item) => item.status === 'ready' || item.status === 'approved_waiting')
        .map((item) => item.targetKey),
    );
    for (const target of targets) await this.drainTarget(target);
  }

  async approve(itemId: string): Promise<void> {
    const target = await this.storage.mutateState((state) => {
      const item = state.queue.find((candidate) => candidate.id === itemId);
      if (!item || item.status !== 'awaiting_confirmation') return null;
      item.status = 'approved_waiting';
      state.history.push(historyEntry(item.ruleId, item.targetKey, 'approved'));
      return item.targetKey;
    });
    if (!target) return;
    const config = await this.storage.loadConfig();
    if (config.defaults.settleMs > 0) await this.sleep(config.defaults.settleMs);
    await this.drainTarget(target);
    await this.refreshPendingMetadata();
  }

  async reject(itemId: string): Promise<void> {
    const result = await this.storage.mutateState((state) => {
      const item = state.queue.find((candidate) => candidate.id === itemId);
      if (!item) return null;
      state.queue = state.queue.filter((candidate) => candidate.id !== itemId);
      state.history.push(historyEntry(item.ruleId, item.targetKey, 'rejected'));
      return {targetKey: item.targetKey, oneShotRuleId: item.oneShot ? item.ruleId : null};
    });
    if (!result) return;
    if (result.oneShotRuleId) await this.storage.removeRule(result.oneShotRuleId);
    await this.settleAndDrain(result.targetKey);
    await this.refreshPendingMetadata();
  }

  async retry(itemId: string): Promise<void> {
    const target = await this.storage.mutateState((state) => {
      const item = state.queue.find((candidate) => candidate.id === itemId);
      if (!item || item.status !== 'paused') return null;
      item.status = 'ready';
      delete item.error;
      return item.targetKey;
    });
    if (target) await this.settleAndDrain(target);
    await this.refreshPendingMetadata();
  }

  private async settleAndDrain(target: string): Promise<void> {
    const config = await this.storage.loadConfig();
    if (config.defaults.settleMs > 0) await this.sleep(config.defaults.settleMs);
    await this.drainTarget(target);
  }

  private async reconcileClosedPane(paneId?: string): Promise<void> {
    if (!paneId) return;
    await this.storage.mutateState((state) => {
      for (const [key, observation] of Object.entries(state.observations)) {
        if (observation.paneId === paneId) delete state.observations[key];
      }
      for (const item of state.queue.filter((candidate) => candidate.targetPaneId === paneId)) {
        item.status = 'paused';
        item.error = 'Agent pane closed';
        state.history.push(historyEntry(item.ruleId, item.targetKey, 'paused', item.error));
      }
    });
    await this.refreshPendingMetadata();
  }

  async refreshPendingMetadata(): Promise<void> {
    const state = await this.storage.readState();
    const counts = new Map<string, number>();
    const panes = new Map<string, string>();
    for (const item of state.queue) {
      if (item.status === 'awaiting_confirmation' || item.status === 'paused') {
        counts.set(item.targetKey, (counts.get(item.targetKey) ?? 0) + 1);
        panes.set(item.targetKey, item.targetPaneId);
      }
    }
    for (const [target, observation] of Object.entries(state.observations)) {
      panes.set(target, observation.paneId);
    }
    for (const [target, paneId] of panes) {
      await this.herdr.reportPending(paneId, counts.get(target) ?? 0);
    }
  }
}
