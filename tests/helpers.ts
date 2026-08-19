import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {HerdrClient} from '../src/herdr.js';
import type {AgentInfo, RuntimeSnapshot, WorkspaceInfo} from '../src/model.js';
import {PluginStorage} from '../src/storage.js';

export const agent = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  agent: 'codex',
  agent_status: 'idle',
  cwd: '/work/project',
  pane_id: 'w1:p1',
  revision: 1,
  state_change_seq: 1,
  tab_id: 'w1:t1',
  terminal_id: 'term-1',
  workspace_id: 'w1',
  ...overrides,
});

export const workspace = (overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  workspace_id: 'w1',
  label: 'project',
  ...overrides,
});

export class FakeHerdr implements HerdrClient {
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  prompts: Array<{target: string; prompt: string}> = [];
  notifications: Array<{title: string; body: string; sound?: string}> = [];
  metadata: Array<{paneId: string; count: number}> = [];
  managerOpened = false;
  quickAddOpenedFor: string | null = null;
  promptError: Error | null = null;
  lifecycleAuthoritative = true;

  constructor(snapshot: RuntimeSnapshot) {
    this.agents = snapshot.agents;
    this.workspaces = snapshot.workspaces;
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    return {
      agents: structuredClone(this.agents),
      workspaces: structuredClone(this.workspaces),
    };
  }

  async getAgent(target: string): Promise<AgentInfo | null> {
    return structuredClone(
      this.agents.find(
        (candidate) => candidate.pane_id === target || candidate.agent === target,
      ) ?? null,
    );
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceInfo | null> {
    return structuredClone(
      this.workspaces.find((candidate) => candidate.workspace_id === workspaceId) ?? null,
    );
  }

  async getAgentDiagnostics(): Promise<{lifecycleAuthoritative: boolean}> {
    return {lifecycleAuthoritative: this.lifecycleAuthoritative};
  }

  async prompt(target: string, prompt: string): Promise<void> {
    if (this.promptError) throw this.promptError;
    this.prompts.push({target, prompt});
  }

  async notify(title: string, body: string, sound?: 'none' | 'done' | 'request'): Promise<void> {
    this.notifications.push({title, body, ...(sound ? {sound} : {})});
  }

  async reportPending(paneId: string, count: number): Promise<void> {
    this.metadata.push({paneId, count});
  }

  async openManager(): Promise<void> {
    this.managerOpened = true;
  }

  async openQuickAdd(sourcePaneId: string): Promise<void> {
    this.quickAddOpenedFor = sourcePaneId;
  }

  setAgent(target: string, patch: Partial<AgentInfo>): AgentInfo {
    const index = this.agents.findIndex(
      (candidate) => candidate.terminal_id === target || candidate.pane_id === target,
    );
    if (index < 0) throw new Error(`Missing fake agent ${target}`);
    this.agents[index] = {...this.agents[index]!, ...patch};
    return this.agents[index]!;
  }
}

export const temporaryStorage = async (): Promise<PluginStorage> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prompt-bucket-test-'));
  return new PluginStorage({configDir: path.join(root, 'config'), stateDir: path.join(root, 'state')});
};
