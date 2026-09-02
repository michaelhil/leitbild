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
- [ ] Deploy, remove only retired World catalog entries, verify existing Runs and Agents content.

## Adversarial constraints

Do not infer card actions from capability ordering or risk. Do not put Run names
in Host storage or alter immutable launch provenance. No default Scenario or
startup compilation of every example. No hidden Agent-room creation or generic
composition language. Keep editor controls separate from card activation. A
deleted reusable card must not destroy live resources or reappear on restart.
Retain data needed by existing Runs as live dependencies, not aliases or archives.
