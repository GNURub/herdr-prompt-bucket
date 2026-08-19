import {randomUUID} from 'node:crypto';
import {constants, copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import YAML from 'yaml';
import {
  ConfigSchema,
  emptyRuntimeState,
  type PromptBucketConfig,
  type RuntimeState,
} from './model.js';

export interface StoragePaths {
  configDir: string;
  stateDir: string;
}

const defaultConfig = (): PromptBucketConfig => ({
  version: 1,
  defaults: {
    settleMs: 2_000,
    pendingTtlMs: 86_400_000,
    repeat: {maxRunsPerSession: 1, cooldownMs: 0},
  },
  rules: [],
});

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const writeAtomic = async (file: string, contents: string): Promise<void> => {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, contents, {encoding: 'utf8', mode: 0o600});
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const normalizeState = (value: unknown): RuntimeState => {
  if (!value || typeof value !== 'object') return emptyRuntimeState();
  const candidate = value as Partial<RuntimeState>;
  if (candidate.version !== 1) return emptyRuntimeState();
  return {
    version: 1,
    observations: candidate.observations ?? {},
    workspaces: candidate.workspaces ?? {},
    queue: Array.isArray(candidate.queue) ? candidate.queue : [],
    runs: candidate.runs ?? {},
    handledTransitions: Array.isArray(candidate.handledTransitions)
      ? candidate.handledTransitions
      : [],
    history: Array.isArray(candidate.history) ? candidate.history : [],
  };
};

export class PluginStorage {
  readonly configPath: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly draftDir: string;

  constructor(readonly paths: StoragePaths) {
    this.configPath = path.join(paths.configDir, 'prompts.yaml');
    this.statePath = path.join(paths.stateDir, 'state.json');
    this.lockPath = path.join(paths.stateDir, '.state.lock');
    this.draftDir = path.join(paths.stateDir, 'drafts');
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): PluginStorage {
    const configDir = environment.HERDR_PLUGIN_CONFIG_DIR;
    const stateDir = environment.HERDR_PLUGIN_STATE_DIR;
    if (!configDir || !stateDir) {
      throw new Error('HERDR_PLUGIN_CONFIG_DIR and HERDR_PLUGIN_STATE_DIR are required');
    }
    return new PluginStorage({configDir, stateDir});
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.configDir, {recursive: true, mode: 0o700}),
      mkdir(this.paths.stateDir, {recursive: true, mode: 0o700}),
      mkdir(this.draftDir, {recursive: true, mode: 0o700}),
    ]);
    await open(this.lockPath, 'a', 0o600).then((handle) => handle.close());
    if (!(await exists(this.configPath))) {
      await writeAtomic(this.configPath, this.serializeConfig(defaultConfig()));
    }
    if (!(await exists(this.statePath))) {
      await writeAtomic(this.statePath, JSON.stringify(emptyRuntimeState(), null, 2) + '\n');
    }
  }

  async loadConfig(): Promise<PromptBucketConfig> {
    await this.initialize();
    const text = await readFile(this.configPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = YAML.parse(text, {customTags: []});
    } catch (error) {
      throw new Error(`Invalid YAML in ${this.configPath}: ${(error as Error).message}`);
    }
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Invalid prompt bucket configuration: ${issues}`);
    }
    return result.data;
  }

  serializeConfig(config: PromptBucketConfig): string {
    return YAML.stringify(config, {lineWidth: 0});
  }

  async saveConfig(config: PromptBucketConfig): Promise<PromptBucketConfig> {
    await this.initialize();
    const valid = ConfigSchema.parse(config);
    if (await exists(this.configPath)) {
      await copyFile(this.configPath, `${this.configPath}.bak`, constants.COPYFILE_FICLONE).catch(
        async () => copyFile(this.configPath, `${this.configPath}.bak`),
      );
    }
    await writeAtomic(this.configPath, this.serializeConfig(valid));
    return valid;
  }

  private async readStateUnlocked(): Promise<RuntimeState> {
    try {
      return normalizeState(JSON.parse(await readFile(this.statePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRuntimeState();
      const corrupt = `${this.statePath}.corrupt-${Date.now()}`;
      await rename(this.statePath, corrupt).catch(() => undefined);
      return emptyRuntimeState();
    }
  }

  async readState(): Promise<RuntimeState> {
    await this.initialize();
    return this.readStateUnlocked();
  }

  async mutateState<T>(mutator: (state: RuntimeState) => T | Promise<T>): Promise<T> {
    await this.initialize();
    const release = await lockfile.lock(this.lockPath, {
      realpath: false,
      stale: 15_000,
      update: 5_000,
      retries: {retries: 100, factor: 1, minTimeout: 10, maxTimeout: 50, randomize: true},
    });
    try {
      const state = await this.readStateUnlocked();
      const result = await mutator(state);
      state.handledTransitions = state.handledTransitions.slice(-1_000);
      state.history = state.history.slice(-1_000);
      await writeAtomic(this.statePath, JSON.stringify(state, null, 2) + '\n');
      return result;
    } finally {
      await release();
    }
  }
}
