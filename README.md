# herdr-prompt-bucket

A durable, ordered bucket of prompts for coding agents running in [Herdr](https://herdr.dev/).

Prompt Bucket reacts to Herdr's semantic agent states instead of coupling itself to one agent's hook format. It can queue a follow-up when an agent finishes, wait until every agent in a workspace is settled, or surface a safe confirmation when an agent is blocked.

## Why

Coding agents often finish one phase and wait even though the next instruction is predictable: review the diff, run a final verification pass, summarize a workspace, or hand the result to a coordinator. Prompt Bucket stores those instructions as explicit local rules and delivers them only when their trigger is stable.

It is deliberately conservative:

- prompts are serialized per agent;
- an initial idle screen is not treated as completed work;
- `unknown` is never considered settled;
- blocked interactive UIs never receive automatic text;
- automatic rules run once per agent session unless you opt into repetition;
- pending prompts are revalidated after a restart and expire after 24 hours by default.

## Requirements

- Herdr 0.8.0 or newer
- Node.js 20 or newer
- npm during installation

OpenCode, Codex, and Claude Code work through Herdr's normalized `idle`, `working`, `blocked`, and `done` states. Installing Herdr's OpenCode integration improves lifecycle authority; Codex and Claude Code currently use Herdr's screen detection for lifecycle state and may use their integrations for session identity.

Automatic delivery to OpenCode requires that lifecycle integration. This prevents a temporary screen-detected `done` state from accepting a prompt while OpenCode is retrying a provider request:

```sh
herdr integration install opencode
```

Without it, notification rules still work, while automatic or approved queue items pause with a diagnostic instead of entering OpenCode's internal queue.

## Install

```sh
herdr plugin install GNURub/herdr-prompt-bucket
```

Open the manager:

```sh
herdr plugin action invoke dev.gnurub.prompt-bucket.manage
```

Add a prompt for the currently focused agent without leaving Herdr:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "dev.gnurub.prompt-bucket.quick-add"
description = "add prompt to bucket"

[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "dev.gnurub.prompt-bucket.manage"
description = "manage prompt bucket"
```

Put that block in `~/.config/herdr/config.toml` (or `%APPDATA%/herdr/config.toml` on
Windows), then run `herdr server reload-config`. Press the Herdr prefix (`Ctrl+B` by
default), then `a`; type the prompt and press `Enter`. The popup confirms the save;
press `Enter` again to close it. Press the prefix followed by `m` to open the manager
and inspect pending prompts. Quick add creates an automatic, one-shot
`agent_settled` item scoped to the exact focused pane, agent kind, workspace, and
working directory. It is removed from the rule list immediately after successful
delivery. Rules created in the full manager remain reusable unless `oneShot: true` is
set in YAML.

Or open its popup directly:

```sh
herdr plugin pane open --plugin dev.gnurub.prompt-bucket --entrypoint manager
```

The first run creates `prompts.yaml` inside the directory printed by:

```sh
herdr plugin config-dir dev.gnurub.prompt-bucket
```

## Configuration

Rules are evaluated in file order. Every matching non-notification rule is appended to the target agent's queue in that same order.

```yaml
version: 1
defaults:
  settleMs: 2000
  pendingTtlMs: 86400000
  repeat:
    maxRunsPerSession: 1
    cooldownMs: 0
rules:
  - id: final-review
    enabled: true
    trigger: agent_settled
    match:
      agents: [codex, claude, opencode]
      workspaces: ["client-*"]
      cwd: ["**/web-app"]
    action: auto
    prompt: |
      Re-read the original request, inspect the final diff, and fix any remaining issue.

  - id: workspace-summary
    enabled: true
    trigger: workspace_settled
    target: coordinator
    match:
      workspaces: ["client-*"]
    action: confirm
    prompt: |
      All agents in {{workspace}} are settled. Collect their results and produce the final summary.

  - id: blocked-reminder
    enabled: true
    trigger: agent_blocked
    match: {}
    action: notify
    prompt: "{{agent}} needs input in {{workspace}} ({{pane_id}})."
```

The shipped [example configuration](examples/prompts.yaml) contains the same patterns with every rule disabled.

### Triggers

| Trigger | Meaning |
| --- | --- |
| `agent_settled` | An agent previously observed as `working` or `blocked` remains `idle`/`done` for the settle window. |
| `workspace_settled` | At least one agent exists and every recognized agent in the workspace remains `idle`/`done`. Requires `target`, a unique Herdr agent alias in that workspace. |
| `agent_blocked` | Herdr recognizes an approval, permission, or question UI. Only `confirm` and `notify` are valid. |

Give a coordinator a stable alias before using a workspace rule:

```sh
herdr agent rename <pane-id> coordinator
```

### Actions

| Action | Behavior |
| --- | --- |
| `auto` | Queues and delivers the prompt as soon as the target is stably settled. |
| `confirm` | Queues the prompt at its ordered position and asks for approval in the manager. It never steals focus. |
| `notify` | Shows a Herdr notification and records history without sending agent input. |

If a confirmation is approved while its agent remains blocked, it stays queued until the block is resolved and Herdr reports a settled state.

### Filters and templates

`match.agents`, `match.workspaces`, and `match.cwd` are optional glob lists. All supplied dimensions must match. Workspace rules apply agent and cwd filters to their coordinator target.

Prompts support only these non-executable variables:

- `{{agent}}`
- `{{pane_id}}`
- `{{workspace_id}}`
- `{{workspace}}`
- `{{cwd}}`
- `{{status}}`
- `{{trigger}}`

Unknown variables make the configuration invalid. Template values are inserted literally and are never evaluated by a shell.

Prompt bodies are capped at 32,000 characters so delivery remains within portable process argument limits.

### Repetition

The default `maxRunsPerSession: 1` prevents a rule from causing an infinite `finish → prompt → finish` loop. A rule can opt into bounded repetition:

```yaml
repeat:
  maxRunsPerSession: 3
  cooldownMs: 60000
```

## Manager keys

| Key | Action |
| --- | --- |
| `Tab` | Switch between rules, queue, history, and settings |
| `j` / `k` | Move selection |
| `n` / `e` | Create or edit a rule |
| `Space` | Enable or disable a rule |
| `J` / `K` | Reorder a rule |
| `d`, then `d` | Delete a rule |
| `a` / `r` | Approve or reject a queued confirmation |
| `t` | Retry a paused delivery |
| `q` / `Esc` | Close the popup |

Long prompt bodies open in `$VISUAL`, then `$EDITOR`, with `vi` or `notepad.exe` as a platform fallback. Configuration saves are validated, atomic, and backed up to `prompts.yaml.bak`.

The plugin reports `prompt_bucket_pending` as optional pane metadata. Add `$prompt_bucket_pending` to a custom Herdr Agent sidebar row if you want the count visible outside the popup.

## Queue semantics

Prompt Bucket owns and serializes its own queue. It cannot inspect a private, cross-agent message queue because OpenCode, Codex, and Claude Code do not expose one universal queue contract. Its guarantee is narrower and testable: it submits only from a revalidated settled state, sends one prompt at a time per agent, waits for a transition to `working`, and does not advance until Herdr observes the next settled transition.

If delivery stalls, the agent disappears, or its session changes, the item pauses instead of guessing. Retry or reject it from the manager.

## Development

```sh
npm install
npm run check
herdr plugin link "$PWD"
herdr plugin action invoke dev.gnurub.prompt-bucket.validate
```

For a linked checkout, rebuild after source changes:

```sh
npm run build
```

Inspect event and action logs with:

```sh
herdr plugin log list --plugin dev.gnurub.prompt-bucket
```

## Security and privacy

Prompts, queue state, and history stay in Herdr's local plugin config/state directories. The plugin has no telemetry and makes no network requests. History stores rule ids and outcomes, not completed prompt bodies. As with every Herdr plugin, its process runs as your user and can call the Herdr CLI; review the source and manifest before installation.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

Apache-2.0
