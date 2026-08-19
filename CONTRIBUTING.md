# Contributing

1. Install Node.js 20+ and Herdr 0.8.0+.
2. Run `npm install`.
3. Make focused changes with tests.
4. Run `npm run check` before opening a pull request.

When changing queue behavior, include tests for concurrent events, target identity, restart recovery, and blocked-agent safety. Never add automatic shell evaluation to prompt templates or automatic repository-local configuration discovery.
