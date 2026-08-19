# Security policy

## Supported versions

Security fixes are provided for the latest released version.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose local prompts, execute unexpected input, or target the wrong terminal pane. Use GitHub's private vulnerability reporting for this repository and include:

- the affected version;
- the operating system and Herdr version;
- the smallest configuration that reproduces the issue;
- whether agent input was actually submitted.

Prompt Bucket intentionally does not execute template values through a shell, does not load repository-owned configuration, and refuses automatic prompt delivery while an agent is blocked.
