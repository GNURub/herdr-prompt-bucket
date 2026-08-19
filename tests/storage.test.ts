import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {temporaryStorage} from './helpers.js';

describe('plugin storage', () => {
  it('seeds, validates, backs up, and atomically saves configuration', async () => {
    const storage = await temporaryStorage();
    const original = await storage.loadConfig();
    expect(original.rules).toEqual([]);

    await storage.saveConfig({
      ...original,
      rules: [
        {
          id: 'review',
          enabled: false,
          trigger: 'agent_settled',
          match: {},
          action: 'confirm',
          prompt: 'Review the result.',
        },
      ],
    });
    expect((await storage.loadConfig()).rules[0]?.id).toBe('review');
    expect(await readFile(`${storage.configPath}.bak`, 'utf8')).toContain('rules: []');
  });

  it('serializes concurrent state mutations', async () => {
    const storage = await temporaryStorage();
    await Promise.all(
      Array.from({length: 20}, (_, index) =>
        storage.mutateState(async (state) => {
          await new Promise((resolve) => setTimeout(resolve, index % 3));
          state.handledTransitions.push(String(index));
        }),
      ),
    );
    expect(new Set((await storage.readState()).handledTransitions).size).toBe(20);
  });
});
