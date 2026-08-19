#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import {PromptBucketEngine} from './engine.js';
import {CliHerdrClient} from './herdr.js';
import {PluginStorage} from './storage.js';
import {PromptBucketTui} from './tui.js';

const run = async (): Promise<void> => {
  const command = process.argv[2] ?? 'validate';
  const storage = PluginStorage.fromEnvironment();
  const herdr = new CliHerdrClient();
  const engine = new PromptBucketEngine(storage, herdr);

  switch (command) {
    case 'startup':
      await engine.startup();
      break;
    case 'event': {
      const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
      if (!raw) throw new Error('HERDR_PLUGIN_EVENT_JSON is required for event handling');
      await engine.handleEvent(raw);
      break;
    }
    case 'open-manager':
      await storage.initialize();
      await herdr.openManager();
      break;
    case 'validate': {
      const config = await storage.loadConfig();
      process.stdout.write(
        JSON.stringify({ok: true, config: storage.configPath, rules: config.rules.length}) + '\n',
      );
      break;
    }
    case 'tui':
      await storage.initialize();
      render(<PromptBucketTui storage={storage} engine={engine} />);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
};

run().catch(async (error: Error) => {
  process.stderr.write(`prompt-bucket: ${error.message}\n`);
  try {
    const herdr = new CliHerdrClient();
    await herdr.notify('Prompt Bucket error', error.message.slice(0, 500), 'request');
  } catch {
    // The original error remains the authoritative failure.
  }
  process.exitCode = 1;
});
