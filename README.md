# Pi Watch Loop

A generic [Pi](https://pi.dev) extension for one bounded fixed or adaptive watch loop inside a live interactive session. Protocol v1 is in-memory, single-flight, and independent of any particular workflow.

See [the protocol and lifecycle contract](docs/protocol.md) for tool fields, state transitions, safety bounds, commands, and historical TUI evidence.

## Requirements

- Pi 0.85.0 or newer
- Node.js 22.19 or newer for development

## Install

Pin an immutable commit or tag:

```bash
pi install git:github.com/flurdy/pi-watch-loop@<commit-or-tag>
```

For a reviewed local checkout:

```bash
make apply
```

Restart Pi after first linking the extension. `/reload` is sufficient after later source edits.

## Use

Watch skills normally drive the `watch_loop` tool. Inspect the idle or active protocol state directly with:

```text
/watch-status
```

Other local commands are `/watch-stop` and `/watch-resume`. Set `PI_WATCH_LOOP_DISABLED=1` before starting Pi to refuse new watches while keeping status and stop access.

## Development

Use the Node version in `.nvmrc`:

```bash
fnm install
fnm exec --using=.nvmrc npm ci
fnm exec --using=.nvmrc npm run check
```

After committing package changes, verify an isolated immutable Git install:

```bash
fnm exec --using=.nvmrc npm run verify:git-install
```

## Ownership

This repository owns only the generic protocol controller and Pi adapter. Workflow-specific cadence, dashboards, deployment checks, and attended decisions remain in their consuming skills.

The component was extracted from `flurdy/ai-tools` with its three path-scoped commits preserved. See [the extraction history](docs/extraction-history.md).

## Rollback

1. Run `/watch-stop` in a live session.
2. Remove the package or local `~/.pi/agent/extensions/watch-loop` symlink.
3. Run `/reload` or restart Pi.

No state migration is needed because protocol v1 persists no watcher state.

## License

MIT License. See [LICENSE](LICENSE).
