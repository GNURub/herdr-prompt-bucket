# Changelog

All notable changes to this project are documented here.

## 0.1.0 - 2026-08-19

- Add ordered `agent_settled`, `workspace_settled`, and `agent_blocked` rules.
- Add safe prompt templates, per-session limits, cooldowns, and stable-state revalidation.
- Add persistent confirmation, retry, restart recovery, and bounded history.
- Add the Herdr popup manager for rule, queue, history, and settings management.
- Add OpenCode, Codex, and Claude Code smoke-test coverage through Herdr's agent layer.
- Require authoritative OpenCode lifecycle reporting before automatic delivery, preventing prompts from entering OpenCode's own queue during provider retries.
