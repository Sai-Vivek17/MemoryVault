# Contributing

## Development setup

1. Install Node.js 18 or newer.
2. Run `npm ci`.
3. Run `npm run check` and `npm test` before submitting a change.

Use an ephemeral port (`port: 0`) when starting the exported server API in
tests. Keep tests isolated with a temporary AOF path, and close every Store or
server instance during cleanup.

## Pull requests

- Keep each pull request focused on one change.
- Add or update tests for behavioral changes.
- Update the README when commands, configuration, or durability semantics
  change.
- Preserve backward compatibility with existing AOF records when possible.
- Do not commit generated AOF files, credentials, or `.env` files.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.
