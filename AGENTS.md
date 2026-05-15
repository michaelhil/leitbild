# Leitbild Agent Instructions

## Project Guardrails

- Use TypeScript for all source code.
- Do not create JavaScript files unless the user explicitly approves.
- Use Bun for package management, scripts, tests, and local runtime.
- Maintain exactly one main HTTP server at `src/core/api/server.ts`.
- Keep simulation conceptually separate from Leitbild core. Local simulators must use the same adapter boundary as remote simulators.
- Validate external input at trust boundaries: HTTP, WebSocket, simulation feeds, file imports, AI-generated dashboard specs, and generated code.
- Scope real-time broadcasts by session/study. Never broadcast events globally unless the event is explicitly global.
- Avoid silent fallbacks, silent skips, empty catches, or unexplained defaulting when failure should be visible.

## No Mock Or Dummy Functionality

- Never add mock, dummy, placeholder, fake, stubbed, or simulated production functionality as a shortcut.
- Test doubles are allowed only in tests, and must be clearly confined to test files.
- Production paths must either be real, deliberately minimal but functional, or absent.
- If a capability is not ready, expose it as unsupported with an explicit error or leave it out of the product surface.
- Do not add TODO-driven placeholder implementations that future work must replace.

## Architecture Preferences

- Prefer functional modules, factory functions, explicit interfaces, and immutable configuration.
- Avoid classes unless there is a strong technical reason.
- Use async/await instead of `.then()` or `.catch()` chains.
- Keep files and functions small enough to remain navigable.
- Add abstractions only when they protect a real boundary or remove real complexity.
- Keep domain-specific logic in domain modules; keep `core` use-case agnostic.

## Commands

- `bun test` runs tests.
- `bun run check` should run type checking once configured.
- `bun run health` should run project health checks once configured.
