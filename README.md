# Leitbild

A modular simulation and AI-agent sandbox. World owns simulations; Agents owns scoped conversations; the Host presents one Workspace-based product.

Read the [knowledge wiki](https://leitbild.app/wiki) for concepts, architecture, guides and Pack documentation. Authored knowledge lives in the separate `Leitbild-wiki` Git repository; this checkout contains executable code, skills and tests, not a second documentation collection.

## Development

Use Bun 1.4.0. From clean code and wiki checkouts, run `bun run verify /path/to/Leitbild-wiki` for a frozen install, build and three-service smoke in a temporary checkout. The command prints the exact pair and checks that the Host and World serve that publication. For working-tree development, use `bun install` and `bun run validate` for checks, tests and builds, and `bun run knowledge:publish /path/to/Leitbild-wiki` to build a local publication.

Deployment runs `bun run deploy -- --dry-run` or `bun run deploy -- --yes`. It uses the same preparation path with full validation and packages the exact checked code, UI builds and publication. Both commands default to the wiki checkout at `../Leitbild-wiki` or `LEITBILD_KNOWLEDGE_REPOSITORY`.

Source owners are `apps/leitbild`, `apps/world`, and `apps/agents`. Shared contracts are in `packages/contracts`; `packages/procmd` parses procedure documents; `packages/knowledge` provides immutable reference reads without owning simulation or conversation state.

## License and releases

Original code is [MIT licensed](LICENSE). See [third-party and content notices](NOTICE.md) for procedure, icon and dataset exceptions. This is research/simulation software, not a validated operational or safety system.

GitHub releases include a matching knowledge-source archive. Extract it beside this checkout as `Leitbild-wiki`; use `bun run knowledge:publish ../Leitbild-wiki` with a committed Git checkout for local publication. The release also includes the ready-to-use `knowledge-snapshot.json`: place it at `knowledge/snapshot.json` for local runtime use. Publishing edits or deploying requires a clean knowledge Git repository, not merely the snapshot.
