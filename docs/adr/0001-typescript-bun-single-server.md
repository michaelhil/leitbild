# ADR 0001: TypeScript, Bun, And One HTTP Server

## Decision

Leitbild uses TypeScript and Bun as the default runtime, package manager, script runner, and test runner.

The project maintains exactly one main HTTP server at `src/core/api/server.ts`.

## Rationale

This keeps the project easy to run locally and avoids early operational complexity. Additional protocols, including simulation WebSocket clients or MCP-style integrations, must integrate through the main server or through non-HTTP adapters.

## Consequences

- No JavaScript source files.
- No second development server for normal operation.
- UI assets are built and then served by the Bun server.
