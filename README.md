# Leitbild

A modular simulation and AI-agent sandbox. World owns simulations; Agents owns scoped conversations; the Host presents one Workspace-based product.

Read the [knowledge wiki](https://leitbild.app/wiki) for concepts, architecture, guides and Pack documentation. Authored knowledge lives in the separate `Leitbild-wiki` Git repository; this checkout contains executable code, skills and tests, not a second documentation collection.

## Development

Use Bun 1.4.0. Run `bun install`, `bun run check`, and `bun run test`. Module scripts are declared in their `package.json` files. Build a local wiki publication with `bun run knowledge:publish /path/to/Leitbild-wiki`.

Deployment runs `bun run deploy -- --dry-run` or `bun run deploy -- --yes`. It requires a clean knowledge repository at `../Leitbild-wiki` or `LEITBILD_KNOWLEDGE_REPOSITORY`, and records the exact code and knowledge revisions. No Forgejo service is required.

Source owners are `apps/leitbild`, `apps/world`, and `apps/agents`. Shared contracts are in `packages/contracts`; `packages/procmd` parses procedure documents; `packages/knowledge` provides immutable reference reads without owning simulation or conversation state.
