# Workspace and catalog cleanup

Approved scope: simplify the picker and overview, remove embedded Workspace
navigation and the settings modal, give live World Runs independently editable
names, retire World example cards and the one-demo Combined launcher, and author
one Halden four-unit power complex definition through the ordinary Pack pipeline.
Existing Runs, required model artifacts, Agents definitions and conversations stay.

## Implementation and verification

- [x] Replace the eager compiled scenario catalog/default with a Pack runtime resolver.
- [x] Discover bundled definitions; isolate tests from retired examples.
- [x] Store optional World-owned Run names and publish explicit card-action capabilities.
- [x] Express Halden grid topology as validated Pack-owned data; author new scenario.
- [x] Simplify picker, inline names, creation modal, card actions and header navigation.
- [x] Remove Combined launcher and settings/pane navigation; surface lifecycle failures.
- [x] Fix stale editor previews and surface catalog refresh failures.
- [x] Verify definition editing, deletion/restart, naming, discovery, UI and electrical coupling.
- [x] Deploy, remove only retired World catalog entries, verify existing Runs and Agents content.

## Verification record — 2026-09-02

- Release: `20260902T173438Z-7f40413e1f-7a2a0204a0`; clean source commit `7f40413e`.
- Platform check, standalone/combined tests, production packaging and builds passed:
  2,107 tests passed, 2 environment-dependent tests skipped, no failures.
- Host Svelte diagnostics: zero errors/warnings. The four existing editor narrowing
  errors touched by this work were fixed. A supplemental World-wide Svelte check
  still reports 50 pre-existing errors and one warning in 14 other UI files;
  that broader typing debt is not claimed fixed by this cleanup.
- Real local services and the production browser exercised optional-name creation,
  inline names, Enter/Escape, card launch, editor round-trip, source-card deletion
  without Run deletion, the combined panes, map and procedure loading.
- Explicitly removed 33 retired World catalog entries across four Workspaces.
  Each now has only `halden-power-complex` as its World example. All nine original
  Runs and every original Agents Resource id and Definition Revision were retained.
  Pinned revisions and model artifacts remain live dependencies of those Runs.
- The Halden grid topology refactor preserves the exact published model fingerprint;
  a regression test protects persisted runtime-state identity.
- Temporary local and production verification Workspaces were removed. Host,
  World, Agents, Caddy, OSRM and public HTTPS health passed after release activation.

## Adversarial constraints

Do not infer card actions from capability ordering or risk. Do not put Run names
in Host storage or alter immutable launch provenance. No default Scenario or
startup compilation of every example. No hidden Agent-room creation or generic
composition language. Keep editor controls separate from card activation. A
deleted reusable card must not destroy live resources or reappear on restart.
Retain data needed by existing Runs as live dependencies, not aliases or archives.
