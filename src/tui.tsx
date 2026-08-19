import {randomUUID} from 'node:crypto';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Box, Text, useApp, useInput, useStdin} from 'ink';
import TextInput from 'ink-text-input';
import type {PromptBucketEngine} from './engine.js';
import {
  ActionSchema,
  RuleSchema,
  TriggerSchema,
  type PromptBucketConfig,
  type PromptRule,
  type RuntimeState,
} from './model.js';
import type {PluginStorage} from './storage.js';

type View = 'rules' | 'queue' | 'history' | 'settings';
type FormMode = 'rule' | 'settings' | null;

interface TuiProps {
  storage: PluginStorage;
  engine: PromptBucketEngine;
}

const formatTime = (timestamp: number): string => new Date(timestamp).toLocaleString();
const clip = (text: string, length = 68): string =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;

const splitCsv = (value: string): string[] | undefined => {
  const values = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
};

const parseEditor = (): {command: string; arguments: string[]} => {
  const raw = process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad.exe' : 'vi');
  const [command, ...arguments_] = raw.trim().split(/\s+/);
  return {command: command!, arguments: arguments_};
};

interface RuleFormProps {
  initial: PromptRule | undefined;
  storage: PluginStorage;
  onSave(rule: PromptRule): Promise<void>;
  onCancel(): void;
}

const RuleForm = ({initial, storage, onSave, onCancel}: RuleFormProps) => {
  const {setRawMode} = useStdin();
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState({
    id: initial?.id ?? `prompt-${Date.now().toString(36)}`,
    trigger: initial?.trigger ?? 'agent_settled',
    action: initial?.action ?? 'confirm',
    agents: initial?.match.agents?.join(', ') ?? 'codex, claude, opencode',
    workspaces: initial?.match.workspaces?.join(', ') ?? '*',
    cwd: initial?.match.cwd?.join(', ') ?? '**',
    target: initial?.target ?? '',
    maxRuns: String(initial?.repeat?.maxRunsPerSession ?? 1),
    cooldown: String(initial?.repeat?.cooldownMs ?? 0),
  });
  const [input, setInput] = useState(values.id);

  const fields = useMemo(
    () => [
      {key: 'id', label: 'Rule id', hint: 'lower-case letters, numbers, _ or -'},
      {key: 'trigger', label: 'Trigger', hint: 'agent_settled | workspace_settled | agent_blocked'},
      {key: 'action', label: 'Action', hint: 'auto | confirm | notify'},
      {key: 'agents', label: 'Agent globs', hint: 'comma-separated; blank means any'},
      {key: 'workspaces', label: 'Workspace globs', hint: 'comma-separated; blank means any'},
      {key: 'cwd', label: 'CWD globs', hint: 'comma-separated; blank means any'},
      {key: 'target', label: 'Coordinator target', hint: 'required only for workspace_settled'},
      {key: 'maxRuns', label: 'Max runs/session', hint: 'positive integer'},
      {key: 'cooldown', label: 'Cooldown ms', hint: 'zero or positive integer'},
    ] as const,
    [],
  );

  useInput((_input, key) => {
    if (!editing && key.escape) onCancel();
  });

  const submit = async (value: string) => {
    const field = fields[step]!;
    const nextValues = {...values, [field.key]: value.trim()};
    if (field.key === 'trigger' && !TriggerSchema.safeParse(value.trim()).success) {
      setError('Use agent_settled, workspace_settled, or agent_blocked');
      return;
    }
    if (field.key === 'action' && !ActionSchema.safeParse(value.trim()).success) {
      setError('Use auto, confirm, or notify');
      return;
    }
    if (field.key === 'maxRuns' && (!/^\d+$/.test(value) || Number(value) < 1)) {
      setError('Max runs must be a positive integer');
      return;
    }
    if (field.key === 'cooldown' && (!/^\d+$/.test(value) || Number(value) < 0)) {
      setError('Cooldown must be zero or a positive integer');
      return;
    }
    setValues(nextValues);
    setError('');
    if (step < fields.length - 1) {
      const nextStep = step + 1;
      setStep(nextStep);
      setInput(nextValues[fields[nextStep]!.key]);
      return;
    }

    setEditing(true);
    const draft = path.join(storage.draftDir, `prompt-${randomUUID()}.md`);
    try {
      await writeFile(draft, initial?.prompt ?? 'Describe the follow-up work here.\n', {
        mode: 0o600,
      });
      setRawMode(false);
      const editor = parseEditor();
      const result = spawnSync(editor.command, [...editor.arguments, draft], {stdio: 'inherit'});
      setRawMode(true);
      if (result.status !== 0) throw new Error(`${editor.command} exited with status ${result.status}`);
      const prompt = (await readFile(draft, 'utf8')).trim();
      const candidate = RuleSchema.parse({
        id: nextValues.id,
        enabled: initial?.enabled ?? true,
        trigger: nextValues.trigger,
        action: nextValues.action,
        match: {
          ...(splitCsv(nextValues.agents) ? {agents: splitCsv(nextValues.agents)} : {}),
          ...(initial?.match.panes ? {panes: initial.match.panes} : {}),
          ...(splitCsv(nextValues.workspaces) ? {workspaces: splitCsv(nextValues.workspaces)} : {}),
          ...(splitCsv(nextValues.cwd) ? {cwd: splitCsv(nextValues.cwd)} : {}),
        },
        ...(nextValues.target ? {target: nextValues.target} : {}),
        prompt,
        oneShot: initial?.oneShot ?? false,
        repeat: {
          maxRunsPerSession: Number(nextValues.maxRuns),
          cooldownMs: Number(nextValues.cooldown),
        },
      });
      await onSave(candidate);
    } catch (caught) {
      setRawMode(true);
      setError((caught as Error).message);
      setEditing(false);
    } finally {
      await unlink(draft).catch(() => undefined);
    }
  };

  if (editing) return <Text color="cyan">Waiting for editor…</Text>;
  const field = fields[step]!;
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">{initial ? 'Edit rule' : 'New rule'} · {step + 1}/{fields.length}</Text>
      <Text>{field.label}</Text>
      <Text dimColor>{field.hint}</Text>
      <TextInput key={`${field.key}-${step}`} value={input} onChange={setInput} onSubmit={submit} />
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>Enter next · Esc cancel · prompt body opens in $VISUAL/$EDITOR</Text>
    </Box>
  );
};

interface SettingsFormProps {
  config: PromptBucketConfig;
  onSave(config: PromptBucketConfig): Promise<void>;
  onCancel(): void;
}

const SettingsForm = ({config, onSave, onCancel}: SettingsFormProps) => {
  const fields = [
    {key: 'settleMs', label: 'Settle window (ms)'},
    {key: 'pendingTtlMs', label: 'Pending TTL (ms)'},
    {key: 'maxRunsPerSession', label: 'Default max runs/session'},
    {key: 'cooldownMs', label: 'Default cooldown (ms)'},
  ] as const;
  const initial = {
    settleMs: String(config.defaults.settleMs),
    pendingTtlMs: String(config.defaults.pendingTtlMs),
    maxRunsPerSession: String(config.defaults.repeat.maxRunsPerSession),
    cooldownMs: String(config.defaults.repeat.cooldownMs),
  };
  const [values, setValues] = useState(initial);
  const [step, setStep] = useState(0);
  const [input, setInput] = useState(initial.settleMs);
  const [error, setError] = useState('');
  useInput((_input, key) => key.escape && onCancel());

  const submit = async (value: string) => {
    if (!/^\d+$/.test(value)) {
      setError('Enter a non-negative integer');
      return;
    }
    const field = fields[step]!;
    const next = {...values, [field.key]: value};
    setValues(next);
    if (step < fields.length - 1) {
      const nextStep = step + 1;
      setStep(nextStep);
      setInput(next[fields[nextStep]!.key]);
      setError('');
      return;
    }
    await onSave({
      ...config,
      defaults: {
        settleMs: Number(next.settleMs),
        pendingTtlMs: Number(next.pendingTtlMs),
        repeat: {
          maxRunsPerSession: Number(next.maxRunsPerSession),
          cooldownMs: Number(next.cooldownMs),
        },
      },
    });
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Settings · {step + 1}/{fields.length}</Text>
      <Text>{fields[step]!.label}</Text>
      <TextInput key={step} value={input} onChange={setInput} onSubmit={submit} />
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>Enter next · Esc cancel</Text>
    </Box>
  );
};

export const PromptBucketTui = ({storage, engine}: TuiProps) => {
  const {exit} = useApp();
  const [config, setConfig] = useState<PromptBucketConfig | null>(null);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [view, setView] = useState<View>('rules');
  const [selected, setSelected] = useState(0);
  const [form, setForm] = useState<FormMode>(null);
  const [editingRule, setEditingRule] = useState<PromptRule | undefined>();
  const [message, setMessage] = useState('');
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null);
  const [initialViewChosen, setInitialViewChosen] = useState(false);

  const refresh = useCallback(async () => {
    const [nextConfig, nextRuntime] = await Promise.all([
      storage.loadConfig(),
      storage.readState(),
    ]);
    setConfig(nextConfig);
    setRuntime(nextRuntime);
  }, [storage]);

  useEffect(() => {
    void refresh().catch((error: Error) => setMessage(error.message));
  }, [refresh]);

  const pending =
    runtime?.queue.filter(
      (item) => item.status === 'awaiting_confirmation' || item.status === 'paused',
    ).length ?? 0;

  useEffect(() => {
    if (!runtime || initialViewChosen) return;
    if (pending > 0) setView('queue');
    setInitialViewChosen(true);
  }, [initialViewChosen, pending, runtime]);

  const listLength =
    view === 'rules'
      ? config?.rules.length ?? 0
      : view === 'queue'
        ? runtime?.queue.length ?? 0
        : view === 'history'
          ? runtime?.history.length ?? 0
          : 1;

  useEffect(() => {
    setSelected((current) => Math.max(0, Math.min(current, Math.max(0, listLength - 1))));
  }, [listLength]);

  useInput((input, key) => {
    if (form) return;
    if (input === 'q' || key.escape) exit();
    if (key.tab) {
      const views: View[] = ['rules', 'queue', 'history', 'settings'];
      setView(views[(views.indexOf(view) + 1) % views.length]!);
      setSelected(0);
      setDeleteArmed(null);
      return;
    }
    if (key.upArrow || input === 'k') setSelected((current) => Math.max(0, current - 1));
    if (key.downArrow || input === 'j') {
      setSelected((current) => Math.min(Math.max(0, listLength - 1), current + 1));
    }
    if (!config || !runtime) return;

    if (view === 'rules') {
      if (input === 'n') {
        setEditingRule(undefined);
        setForm('rule');
      } else if (input === 'e' && config.rules[selected]) {
        setEditingRule(config.rules[selected]);
        setForm('rule');
      } else if (input === ' ') {
        const rules = [...config.rules];
        const rule = rules[selected];
        if (rule) {
          rules[selected] = {...rule, enabled: !rule.enabled};
          void storage.saveConfig({...config, rules}).then(refresh);
        }
      } else if ((input === 'J' || input === 'K') && config.rules[selected]) {
        const destination = input === 'J' ? selected + 1 : selected - 1;
        if (destination >= 0 && destination < config.rules.length) {
          const rules = [...config.rules];
          const [rule] = rules.splice(selected, 1);
          rules.splice(destination, 0, rule!);
          void storage.saveConfig({...config, rules}).then(() => {
            setSelected(destination);
            return refresh();
          });
        }
      } else if (input === 'd' && config.rules[selected]) {
        const rule = config.rules[selected]!;
        if (deleteArmed === rule.id) {
          void storage
            .saveConfig({...config, rules: config.rules.filter((candidate) => candidate.id !== rule.id)})
            .then(() => {
              setDeleteArmed(null);
              setMessage(`Deleted ${rule.id}`);
              return refresh();
            });
        } else {
          setDeleteArmed(rule.id);
          setMessage(`Press d again to delete ${rule.id}`);
        }
      }
    } else if (view === 'queue') {
      const item = runtime.queue[selected];
      if (input === 'a' && item?.status === 'awaiting_confirmation') {
        void engine.approve(item.id).then(refresh);
      } else if (input === 'r' && item) {
        void engine.reject(item.id).then(refresh);
      } else if (input === 't' && item?.status === 'paused') {
        void engine.retry(item.id).then(refresh);
      }
    } else if (view === 'settings' && input === 'e') {
      setForm('settings');
    }
  });

  if (!config || !runtime) {
    return <Text color={message ? 'red' : 'cyan'}>{message || 'Loading Prompt Bucket…'}</Text>;
  }

  if (form === 'rule') {
    return (
      <RuleForm
        initial={editingRule}
        storage={storage}
        onCancel={() => setForm(null)}
        onSave={async (rule) => {
          const index = editingRule
            ? config.rules.findIndex((candidate) => candidate.id === editingRule.id)
            : -1;
          const rules = [...config.rules];
          if (index >= 0) rules[index] = rule;
          else rules.push(rule);
          await storage.saveConfig({...config, rules});
          setForm(null);
          setMessage(`Saved ${rule.id}`);
          await refresh();
        }}
      />
    );
  }

  if (form === 'settings') {
    return (
      <SettingsForm
        config={config}
        onCancel={() => setForm(null)}
        onSave={async (next) => {
          await storage.saveConfig(next);
          setForm(null);
          setMessage('Settings saved');
          await refresh();
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">Prompt Bucket</Text>
        <Text color={pending > 0 ? 'yellow' : 'green'}>{pending} pending</Text>
      </Box>
      <Text>
        {(['rules', 'queue', 'history', 'settings'] as View[]).map((name) => {
          const label = name === 'queue' && pending > 0 ? `queue (${pending})` : name;
          return name === view ? (
            <Text key={name} inverse> {label} </Text>
          ) : (
            <Text key={name}> {label} </Text>
          );
        })}
      </Text>
      <Box flexDirection="column" marginTop={1} minHeight={8}>
        {view === 'rules' && config.rules.length === 0 ? (
          <Text dimColor>No rules. Press n to create one.</Text>
        ) : null}
        {view === 'rules'
          ? config.rules.map((rule, index) => (
              <Text key={rule.id} {...(index === selected ? {color: 'cyan'} : {})}>
                {index === selected ? '›' : ' '} {rule.enabled ? '●' : '○'} {rule.id} · {rule.trigger} · {rule.action}
                {rule.oneShot ? ' · one shot' : ''}
              </Text>
            ))
          : null}
        {view === 'rules' && config.rules[selected] ? (
          <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
            <Text bold>Prompt</Text>
            <Text>{clip(config.rules[selected]!.prompt, 180)}</Text>
            <Text dimColor>
              {config.rules[selected]!.enabled ? 'enabled' : 'disabled'} · action: {config.rules[selected]!.action}
            </Text>
          </Box>
        ) : null}
        {view === 'queue' && runtime.queue.length === 0 ? (
          <Text dimColor>The queue is empty.</Text>
        ) : null}
        {view === 'queue'
          ? runtime.queue.map((item, index) => (
              <Box key={item.id} flexDirection="column">
                <Text {...(index === selected ? {color: 'cyan'} : {})}>
                  {index === selected ? '›' : ' '} {item.status === 'awaiting_confirmation' ? 'PENDING APPROVAL' : item.status} · {item.ruleId}
                </Text>
                {index === selected ? (
                  <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
                    <Text bold>Prompt to send</Text>
                    <Text>{clip(item.prompt, 180)}</Text>
                    <Text dimColor>Target: {item.targetPaneId}</Text>
                    {item.status === 'awaiting_confirmation' ? (
                      <Text bold color="green">Press a to APPROVE AND SEND · r to reject</Text>
                    ) : null}
                    {item.status === 'paused' ? (
                      <Text bold color="yellow">Press t to retry · r to reject</Text>
                    ) : null}
                    {item.error ? <Text color="red">{clip(item.error, 180)}</Text> : null}
                  </Box>
                ) : null}
              </Box>
            ))
          : null}
        {view === 'history'
          ? [...runtime.history].reverse().map((item, index) => (
              <Text key={item.id} {...(index === selected ? {color: 'cyan'} : {})}>
                {index === selected ? '›' : ' '} {formatTime(item.at)} · {item.ruleId} · {item.outcome}
              </Text>
            ))
          : null}
        {view === 'settings' ? (
          <Box flexDirection="column">
            <Text>Config: {storage.configPath}</Text>
            <Text>Settle: {config.defaults.settleMs} ms</Text>
            <Text>Pending TTL: {config.defaults.pendingTtlMs} ms</Text>
            <Text>Default max/session: {config.defaults.repeat.maxRunsPerSession}</Text>
            <Text>Default cooldown: {config.defaults.repeat.cooldownMs} ms</Text>
          </Box>
        ) : null}
      </Box>
      {message ? <Text color={deleteArmed ? 'yellow' : 'green'}>{message}</Text> : null}
      <Text dimColor>
        {view === 'queue'
          ? 'a approve and send · r reject · t retry · j/k select · Tab change view · q close'
          : view === 'rules'
            ? 'n new · e edit · Space enable/disable · J/K reorder · d d delete · Tab change view · q close'
            : 'Tab change view · j/k select · q close'}
      </Text>
    </Box>
  );
};
