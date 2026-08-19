import {beforeEach, describe, expect, it} from 'vitest';
import {normalizePluginEvent, PromptBucketEngine, ruleMatches} from '../src/engine.js';
import type {PromptBucketConfig, PromptRule} from '../src/model.js';
import {agent, FakeHerdr, temporaryStorage, workspace} from './helpers.js';

const automaticRule = (overrides: Partial<PromptRule> = {}): PromptRule => ({
  id: 'follow-up',
  enabled: true,
  trigger: 'agent_settled',
  match: {},
  action: 'auto',
  prompt: 'Review {{workspace}} with {{agent}}.',
  ...overrides,
});

const saveRules = async (
  storage: Awaited<ReturnType<typeof temporaryStorage>>,
  rules: PromptRule[],
) => {
  const config: PromptBucketConfig = {
    version: 1,
    defaults: {
      settleMs: 0,
      pendingTtlMs: 86_400_000,
      repeat: {maxRunsPerSession: 1, cooldownMs: 0},
    },
    rules,
  };
  await storage.saveConfig(config);
};

describe('prompt bucket engine', () => {
  let now: number;

  beforeEach(() => {
    now = 1_800_000_000_000;
  });

  it('normalizes the event envelope emitted by Herdr plugins', () => {
    expect(
      normalizePluginEvent(
        JSON.stringify({
          event: 'pane_agent_status_changed',
          data: {
            type: 'pane_agent_status_changed',
            pane_id: 'w1:p1',
            agent_status: 'done',
          },
        }),
      ),
    ).toEqual({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'done'});
  });

  it('matches safe globs across agent, workspace, and cwd', () => {
    expect(
      ruleMatches(
        automaticRule({
          match: {agents: ['cod*'], panes: ['w1:*'], workspaces: ['proj*'], cwd: ['**/project']},
        }),
        agent(),
        workspace(),
      ),
    ).toBe(true);
  });

  it('removes a one-shot rule after its prompt is sent', async () => {
    const storage = await temporaryStorage();
    await saveRules(storage, [automaticRule({id: 'one-time', oneShot: true})]);
    const herdr = new FakeHerdr({
      agents: [agent({agent_status: 'working'})],
      workspaces: [workspace()],
    });
    const engine = new PromptBucketEngine(storage, herdr, () => now, async () => undefined);
    await engine.startup();

    herdr.setAgent('term-1', {agent_status: 'idle', state_change_seq: 2});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'idle'}),
    );

    expect(herdr.prompts).toHaveLength(1);
    expect((await storage.loadConfig()).rules).toEqual([]);
    expect((await storage.readState()).queue[0]).toMatchObject({
      ruleId: 'one-time',
      status: 'in_flight',
      oneShot: true,
    });
  });

  it('sends a directly queued one-shot immediately when the agent is already free', async () => {
    const storage = await temporaryStorage();
    const freeAgent = agent({agent_status: 'done'});
    const herdr = new FakeHerdr({agents: [freeAgent], workspaces: [workspace()]});
    const engine = new PromptBucketEngine(storage, herdr, () => now, async () => undefined);

    const outcome = await engine.enqueueOneShot(
      automaticRule({id: 'queued-once', oneShot: true, prompt: 'next task'}),
      freeAgent,
    );

    expect(outcome).toBe('sent');
    expect(herdr.prompts).toEqual([{target: 'w1:p1', prompt: 'next task'}]);
    expect((await storage.loadConfig()).rules).toEqual([]);
    expect((await storage.readState()).runs).toEqual({});
  });

  it('does not trigger from an initial idle snapshot', async () => {
    const storage = await temporaryStorage();
    await saveRules(storage, [automaticRule()]);
    const herdr = new FakeHerdr({agents: [agent()], workspaces: [workspace()]});
    const engine = new PromptBucketEngine(storage, herdr, () => now, async () => undefined);
    await engine.startup();
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'idle'}),
    );
    expect(herdr.prompts).toEqual([]);
  });

  it('sends one automatic prompt after working settles and never loops by default', async () => {
    const storage = await temporaryStorage();
    await saveRules(storage, [automaticRule()]);
    const herdr = new FakeHerdr({
      agents: [agent({agent_status: 'working'})],
      workspaces: [workspace()],
    });
    const engine = new PromptBucketEngine(storage, herdr, () => now, async () => undefined);
    await engine.startup();

    herdr.setAgent('term-1', {agent_status: 'idle', state_change_seq: 2});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'idle'}),
    );
    expect(herdr.prompts).toEqual([
      {target: 'w1:p1', prompt: 'Review project with codex.'},
    ]);

    herdr.setAgent('term-1', {agent_status: 'working', state_change_seq: 3});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'working'}),
    );
    herdr.setAgent('term-1', {agent_status: 'done', state_change_seq: 4});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'done'}),
    );
    expect(herdr.prompts).toHaveLength(1);
    expect((await storage.readState()).queue).toEqual([]);
  });

  it('drains all matching rules in YAML order, one completed turn at a time', async () => {
    const storage = await temporaryStorage();
    await saveRules(storage, [
      automaticRule({id: 'first', prompt: 'first'}),
      automaticRule({id: 'second', prompt: 'second'}),
    ]);
    const herdr = new FakeHerdr({
      agents: [agent({agent_status: 'working'})],
      workspaces: [workspace()],
    });
    const engine = new PromptBucketEngine(storage, herdr, () => now, async () => undefined);
    await engine.startup();

    herdr.setAgent('term-1', {agent_status: 'idle', state_change_seq: 2});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'idle'}),
    );
    expect(herdr.prompts.map((call) => call.prompt)).toEqual(['first']);

    herdr.setAgent('term-1', {agent_status: 'working', state_change_seq: 3});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'working'}),
    );
    herdr.setAgent('term-1', {agent_status: 'idle', state_change_seq: 4});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'idle'}),
    );
    expect(herdr.prompts.map((call) => call.prompt)).toEqual(['first', 'second']);
  });

  it('queues a blocked confirmation without writing to the interactive UI', async () => {
    const storage = await temporaryStorage();
    await saveRules(storage, [
      automaticRule({
        id: 'blocked-help',
        trigger: 'agent_blocked',
        action: 'confirm',
        prompt: 'Continue after the user resolves the block.',
      }),
    ]);
    const herdr = new FakeHerdr({
      agents: [agent({agent_status: 'working'})],
      workspaces: [workspace()],
    });
    const engine = new PromptBucketEngine(storage, herdr, () => now, async () => undefined);
    await engine.startup();
    herdr.setAgent('term-1', {agent_status: 'blocked', state_change_seq: 2});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'blocked'}),
    );
    expect(herdr.prompts).toEqual([]);
    const [pending] = (await storage.readState()).queue;
    expect(pending?.status).toBe('awaiting_confirmation');

    await engine.approve(pending!.id);
    expect(herdr.prompts).toEqual([]);
    herdr.setAgent('term-1', {agent_status: 'idle', state_change_seq: 3});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'idle'}),
    );
    expect(herdr.prompts.map((call) => call.prompt)).toEqual([
      'Continue after the user resolves the block.',
    ]);
  });

  it('targets a named coordinator only when the whole workspace is settled', async () => {
    const storage = await temporaryStorage();
    await saveRules(storage, [
      automaticRule({
        id: 'workspace-summary',
        trigger: 'workspace_settled',
        target: 'coordinator',
        prompt: 'Summarize {{workspace}}.',
      }),
    ]);
    const worker = agent({agent: 'claude', agent_status: 'working'});
    const coordinator = agent({
      agent: 'coordinator',
      pane_id: 'w1:p2',
      terminal_id: 'term-2',
      agent_status: 'idle',
    });
    const herdr = new FakeHerdr({agents: [worker, coordinator], workspaces: [workspace()]});
    const engine = new PromptBucketEngine(storage, herdr, () => now, async () => undefined);
    await engine.startup();

    herdr.setAgent('term-1', {agent_status: 'done', state_change_seq: 2});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'done'}),
    );
    expect(herdr.prompts).toEqual([{target: 'w1:p2', prompt: 'Summarize project.'}]);
  });

  it('pauses a failed delivery and allows an explicit retry', async () => {
    const storage = await temporaryStorage();
    await saveRules(storage, [automaticRule()]);
    const herdr = new FakeHerdr({
      agents: [agent({agent_status: 'working'})],
      workspaces: [workspace()],
    });
    herdr.promptError = new Error('agent_prompt_stalled');
    const engine = new PromptBucketEngine(storage, herdr, () => now, async () => undefined);
    await engine.startup();
    herdr.setAgent('term-1', {agent_status: 'idle', state_change_seq: 2});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'idle'}),
    );
    const [paused] = (await storage.readState()).queue;
    expect(paused?.status).toBe('paused');
    herdr.promptError = null;
    await engine.retry(paused!.id);
    expect(herdr.prompts).toHaveLength(1);
  });

  it('refuses to queue input inside OpenCode without lifecycle authority', async () => {
    const storage = await temporaryStorage();
    await saveRules(storage, [automaticRule()]);
    const herdr = new FakeHerdr({
      agents: [agent({agent: 'opencode', agent_status: 'working'})],
      workspaces: [workspace()],
    });
    herdr.lifecycleAuthoritative = false;
    const engine = new PromptBucketEngine(storage, herdr, () => now, async () => undefined);
    await engine.startup();
    herdr.setAgent('term-1', {agent_status: 'idle', state_change_seq: 2});
    await engine.handleEvent(
      JSON.stringify({type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'idle'}),
    );
    expect(herdr.prompts).toEqual([]);
    expect((await storage.readState()).queue[0]).toMatchObject({
      status: 'paused',
      error: expect.stringContaining('herdr integration install opencode'),
    });
  });
});
