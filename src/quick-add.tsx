import {randomUUID} from 'node:crypto';
import React, {useEffect, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import TextInput from 'ink-text-input';
import {escape} from 'minimatch';
import type {PromptBucketEngine} from './engine.js';
import type {HerdrClient} from './herdr.js';
import {RuleSchema, type AgentInfo, type PromptRule, type WorkspaceInfo} from './model.js';

interface QuickAddProps {
  engine: PromptBucketEngine;
  herdr: HerdrClient;
  sourcePaneId: string;
}

export const buildQuickRule = (
  agent: AgentInfo,
  workspace: WorkspaceInfo,
  prompt: string,
  now = Date.now(),
  suffix = randomUUID().slice(0, 6),
): PromptRule =>
  RuleSchema.parse({
    id: `quick-${now.toString(36)}-${suffix}`,
    enabled: true,
    trigger: 'agent_settled',
    action: 'auto',
    match: {
      agents: [escape(agent.agent)],
      panes: [escape(agent.pane_id)],
      workspaces: [escape(workspace.label)],
      cwd: [escape(agent.cwd)],
    },
    prompt: prompt.trim(),
    oneShot: true,
    repeat: {maxRunsPerSession: 1, cooldownMs: 0},
  });

export const QuickAddTui = ({engine, herdr, sourcePaneId}: QuickAddProps) => {
  const {exit} = useApp();
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedRuleId, setSavedRuleId] = useState('');

  useEffect(() => {
    void (async () => {
      const foundAgent = await herdr.getAgent(sourcePaneId);
      if (!foundAgent) throw new Error('The focused pane does not contain a detected agent');
      const foundWorkspace = await herdr.getWorkspace(foundAgent.workspace_id);
      if (!foundWorkspace) throw new Error('The focused agent workspace was not found');
      setAgent(foundAgent);
      setWorkspace(foundWorkspace);
    })().catch((caught: Error) => setError(caught.message));
  }, [herdr, sourcePaneId]);

  useInput((_input, key) => {
    if ((key.escape || (savedRuleId && key.return)) && !saving) exit();
  });

  const save = async (value: string) => {
    if (!agent || !workspace || saving) return;
    if (!value.trim()) {
      setError('Write a prompt before saving');
      return;
    }
    setSaving(true);
    try {
      const rule = buildQuickRule(agent, workspace, value);
      const outcome = await engine.enqueueOneShot(rule, agent);
      await herdr.notify(
        outcome === 'sent' ? 'Prompt sent' : 'Prompt added to bucket',
        outcome === 'sent'
          ? `${rule.id} was sent to ${agent.agent}`
          : `${rule.id} will be sent once when ${agent.agent} settles`,
        'none',
      );
      setSavedRuleId(rule.id);
      setSaving(false);
    } catch (caught) {
      setError((caught as Error).message);
      setSaving(false);
    }
  };

  if (error && !agent) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="red">Cannot add prompt</Text>
        <Text>{error}</Text>
        <Text dimColor>Esc close</Text>
      </Box>
    );
  }

  if (!agent || !workspace) return <Text color="cyan">Loading focused agent…</Text>;

  if (savedRuleId) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="green">✓ Prompt saved</Text>
        <Text>{savedRuleId}</Text>
        <Text>Queued for {agent.agent}; it disappears after its single delivery.</Text>
        <Text dimColor>Enter or Esc close · Ctrl+B then m opens the bucket</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Add prompt to bucket</Text>
      <Text>
        {agent.agent} · {workspace.label} · when this agent settles
      </Text>
      <Box marginTop={1}>
        <Text color="cyan">Prompt › </Text>
        <TextInput value={prompt} onChange={setPrompt} onSubmit={save} />
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        {saving ? 'Saving…' : 'Enter save · Esc cancel · automatic · one shot'}
      </Text>
    </Box>
  );
};
