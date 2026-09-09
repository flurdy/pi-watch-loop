# Agent Instructions

## Development

- Use Node.js from `.nvmrc`.
- Keep the extension generic: workflow-specific watch behavior belongs in the consuming skill repository.
- Use the root npm scripts for tests, typechecking, package checks, and immutable Git-install verification.
- Keep `package.json#files` as an exact runtime allowlist. Do not package tests, local configuration, smoke evidence, or development scripts.
- Preserve protocol-v1 compatibility unless a separately reviewed versioned protocol change is explicitly requested.

## Completion

- Run `npm run check` and, after committing, `npm run verify:git-install`.
- A current-Pi TUI smoke is required for lifecycle or distribution changes; keep raw output under ignored `.artifacts/` and retain only a concise reviewed result when needed.
- Stage explicit paths and commit locally. Never push, tag, publish, or change an installed extension link without explicit approval immediately beforehand.
