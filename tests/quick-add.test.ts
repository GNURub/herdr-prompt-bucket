import {describe, expect, it} from 'vitest';
import {buildQuickRule} from '../src/quick-add.js';
import {agent, workspace} from './helpers.js';

describe('quick add', () => {
  it('creates a safe focused-agent rule with conservative defaults', () => {
    const rule = buildQuickRule(
      agent({agent: 'codex', cwd: '/work/project[one]'}),
      workspace({label: 'release*work'}),
      '  Review the completed change.  ',
      1_700_000_000_000,
      'abc123',
    );

    expect(rule).toMatchObject({
      id: 'quick-loyw3v28-abc123',
      enabled: true,
      trigger: 'agent_settled',
      action: 'auto',
      prompt: 'Review the completed change.',
      oneShot: true,
      repeat: {maxRunsPerSession: 1, cooldownMs: 0},
    });
    expect(rule.match).toEqual({
      agents: ['codex'],
      panes: ['w1:p1'],
      workspaces: ['release\\*work'],
      cwd: ['/work/project\\[one\\]'],
    });
  });

  it('rejects an empty prompt', () => {
    expect(() => buildQuickRule(agent(), workspace(), '   ', 1, 'abc123')).toThrow();
  });
});
