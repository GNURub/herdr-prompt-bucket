import {describe, expect, it} from 'vitest';
import {ConfigSchema} from '../src/model.js';
import {renderTemplate} from '../src/template.js';

describe('configuration contract', () => {
  it('applies safe defaults', () => {
    const parsed = ConfigSchema.parse({version: 1, rules: []});
    expect(parsed.defaults).toEqual({
      settleMs: 2_000,
      pendingTtlMs: 86_400_000,
      repeat: {maxRunsPerSession: 1, cooldownMs: 0},
    });
  });

  it('rejects automatic writes into blocked agent UIs', () => {
    const parsed = ConfigSchema.safeParse({
      version: 1,
      rules: [
        {
          id: 'unsafe',
          trigger: 'agent_blocked',
          action: 'auto',
          prompt: 'continue',
        },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('cannot send prompts automatically');
  });

  it('requires a coordinator for workspace rules', () => {
    expect(
      ConfigSchema.safeParse({
        version: 1,
        rules: [
          {
            id: 'workspace-review',
            trigger: 'workspace_settled',
            action: 'confirm',
            prompt: 'review',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown template variables and renders known values literally', () => {
    expect(
      ConfigSchema.safeParse({
        version: 1,
        rules: [
          {
            id: 'bad-template',
            trigger: 'agent_settled',
            action: 'notify',
            prompt: '{{shell_command}}',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      renderTemplate('{{agent}} at {{cwd}}', {
        agent: 'codex',
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        workspace: 'project',
        cwd: '/work/project',
        status: 'idle',
        trigger: 'agent_settled',
      }),
    ).toBe('codex at /work/project');
  });
});
