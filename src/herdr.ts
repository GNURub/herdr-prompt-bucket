import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {AgentInfo, RuntimeSnapshot, WorkspaceInfo} from './model.js';

const execFileAsync = promisify(execFile);

export interface HerdrClient {
  snapshot(): Promise<RuntimeSnapshot>;
  getAgent(target: string): Promise<AgentInfo | null>;
  getWorkspace(workspaceId: string): Promise<WorkspaceInfo | null>;
  getAgentDiagnostics(target: string): Promise<{lifecycleAuthoritative: boolean}>;
  prompt(target: string, prompt: string): Promise<void>;
  notify(title: string, body: string, sound?: 'none' | 'done' | 'request'): Promise<void>;
  reportPending(paneId: string, count: number): Promise<void>;
  openManager(): Promise<void>;
  openQuickAdd(sourcePaneId: string): Promise<void>;
}

interface HerdrEnvelope<T> {
  result: T;
}

const parseEnvelope = <T>(stdout: string): T => {
  const parsed = JSON.parse(stdout) as HerdrEnvelope<T>;
  return parsed.result;
};

export class CliHerdrClient implements HerdrClient {
  constructor(
    readonly binary = process.env.HERDR_BIN_PATH ?? 'herdr',
    readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  private async run(arguments_: string[]): Promise<string> {
    const {stdout} = await execFileAsync(this.binary, arguments_, {
      encoding: 'utf8',
      env: this.environment,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    const result = parseEnvelope<{snapshot: RuntimeSnapshot}>(await this.run(['api', 'snapshot']));
    return result.snapshot;
  }

  async getAgent(target: string): Promise<AgentInfo | null> {
    try {
      const result = parseEnvelope<{agent: AgentInfo}>(await this.run(['agent', 'get', target]));
      return result.agent;
    } catch {
      return null;
    }
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceInfo | null> {
    try {
      const result = parseEnvelope<{workspace: WorkspaceInfo}>(
        await this.run(['workspace', 'get', workspaceId]),
      );
      return result.workspace;
    } catch {
      return null;
    }
  }

  async getAgentDiagnostics(target: string): Promise<{lifecycleAuthoritative: boolean}> {
    try {
      const parsed = JSON.parse(await this.run(['agent', 'explain', target, '--json'])) as {
        screen_detection_skipped?: boolean;
      };
      return {lifecycleAuthoritative: parsed.screen_detection_skipped === true};
    } catch {
      return {lifecycleAuthoritative: false};
    }
  }

  async prompt(target: string, prompt: string): Promise<void> {
    await this.run([
      'agent',
      'prompt',
      target,
      prompt,
      '--wait',
      '--until',
      'working',
      '--timeout',
      '5000',
    ]);
  }

  async notify(
    title: string,
    body: string,
    sound: 'none' | 'done' | 'request' = 'request',
  ): Promise<void> {
    await this.run(['notification', 'show', title, '--body', body, '--sound', sound]);
  }

  async reportPending(paneId: string, count: number): Promise<void> {
    try {
      const arguments_ = [
        'pane',
        'report-metadata',
        paneId,
        '--source',
        'plugin:prompt-bucket',
        ...(count > 0
          ? ['--token', `prompt_bucket_pending=${count}`, '--ttl-ms', '86400000']
          : ['--clear-token', 'prompt_bucket_pending']),
      ];
      await this.run(arguments_);
    } catch {
      // Metadata is a convenience. Queue correctness must not depend on sidebar configuration.
    }
  }

  async openManager(): Promise<void> {
    await this.run([
      'plugin',
      'pane',
      'open',
      '--plugin',
      'dev.gnurub.prompt-bucket',
      '--entrypoint',
      'manager',
    ]);
  }

  async openQuickAdd(sourcePaneId: string): Promise<void> {
    await this.run([
      'plugin',
      'pane',
      'open',
      '--plugin',
      'dev.gnurub.prompt-bucket',
      '--entrypoint',
      'quick-add',
      '--env',
      `PROMPT_BUCKET_SOURCE_PANE_ID=${sourcePaneId}`,
    ]);
  }
}
