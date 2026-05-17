# ADR 0012: Svelte 5 UI Architecture

## Status

Accepted.

## Context

Leitbild uses Svelte 5, but early UI code used classic Svelte component patterns such as `export let`, `$:` reactive statements, `on:` event directives, and slots. Those patterns still work, but mixing classic syntax with Svelte 5 runes makes state ownership harder to audit.

The control surface is becoming central to Leitbild: it coordinates Control Instance state, map rendering, object presentation, placement workflows, modal workflows, and future adaptive UI surfaces. Regressions in derived UI state, such as category field visibility not updating after a refactor, show that hidden reactive dependencies are a real risk.

## Decision

Svelte 5 runes are the default architecture for new and actively migrated UI code.

- Use `$props` for component inputs.
- Use `$state` for local mutable UI state.
- Use `$derived` for derived UI state.
- Use `$effect` only for synchronization with external systems, timers, browser APIs, network connections, or imperative libraries.
- Use modern event attributes such as `onclick` in migrated components.
- Prefer snippets over slots when migrating shared composition components and when the result improves typed composition.
- Use `.svelte.ts` modules for shared client-side UI state when the module has real depth: lifecycle, invariants, persistence, or coordination behind a small interface.

The primary `src/ui` Svelte component surface should stay fully migrated: no `export let`, `$:` reactive statements, `on:` event directives, deprecated module-script syntax, slot-based modal APIs, or `<svelte:component>` usage unless there is a written reason.

## State Ownership Rules

- The Control Instance Projected State remains canonical shared operational truth.
- Svelte state may hold client-local UI state such as selected controls, open menus, rail width, startup modal state, placement drafts, and transient map lifecycle flags.
- Svelte state must not become a second canonical object store.
- Derived UI models may be represented as pure TypeScript selectors when this improves testability or prevents hidden reactive dependency bugs.
- Pure selectors should not become pass-through modules. They must concentrate real derivation logic or be deleted.

## Migration Order

1. Resolve dirty partial migrations before starting new UI work.
2. Migrate `ControlRail` and its immediate rail components first, because this is where the field-visibility regression occurred.
3. Migrate leaf components next.
4. Migrate modal composition and form ownership.
5. Extract deep client UI state modules from `App.svelte`.
6. Migrate `MapSurface` carefully, keeping MapLibre lifecycle imperative and isolated.
7. Audit remaining classic syntax and either migrate it or document why it remains.

This migration is complete for the current `src/ui` component set as of the runes pass that introduced `rail-layout-state.svelte.ts` and `placement-state.svelte.ts`.

## Structural Patterns

- `App.svelte` coordinates Control Instance state, route selection, startup lifecycle, and lazy loading, but delegates deeper UI workflows to focused rune state modules.
- `rail-layout-state.svelte.ts` owns rail width persistence, collapse behavior, resize pointer listeners, and layout invalidation.
- `placement-state.svelte.ts` owns map placement mode, route/polygon point accumulation, create-draft creation, and user-facing placement status text.
- `ModalShell.svelte` uses snippets for typed modal body/footer composition instead of slot fragments.
- `MapSurface.svelte` is an imperative MapLibre adapter. Svelte effects synchronize input boundaries such as object updates, theme changes, layout resize, and placement cursor changes, but MapLibre owns its internal map lifecycle.

## Consequences

Benefits:

- More explicit state ownership.
- Fewer hidden dependency bugs in derived UI state.
- Better locality for UI state and lifecycle behavior.
- Cleaner seams between Svelte UI, Control Instance state, MapLibre, and pack presentation.

Costs:

- Runes are now used throughout the current UI component surface, which reduces mixed-pattern overhead.
- Runes require discipline: `$effect` can become a dumping ground if used for ordinary derivation.
- `.svelte.ts` state modules can become shallow pass-through wrappers if created too eagerly.

## Guardrails

- Do not use `$effect` to compute values that can be `$derived`.
- Do not add global UI stores for state that is local to one surface.
- Do not duplicate canonical Control Instance object state in Svelte modules.
- Do not create compatibility layers for both old and new Svelte patterns. Migrate the touched slice cleanly.
