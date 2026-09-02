# Workspace picker and Process Display lifecycle

## Scope and review

- Workspace and Simulation Run names open their cards. An explicit pen button
  activates the shared inline editor; Enter saves and Escape cancels.
- The first Workspace card creates a Workspace with an optional name. The modal
  and its unused styles are removed. Existing cards expose copy-link feedback,
  creation date, rename, and confirmed deletion.
- Presentation changes do not add Host-owned domain state or new APIs. Workspace
  links retain canonical URL identity. Accent colors are decorative, not statuses.

The Process Display previously rendered a loading window before saved geometry
was restored, then replaced its body with the diagram. Startup also waited for
an unrelated action catalog. Polling could overlap, late responses could update a
closed window, and a refresh error replaced the diagram permanently.

The local fix is deliberately smaller than a window framework or shared cache:

1. Discover a display, then read its definition and first snapshot concurrently.
2. Resolve its initial lens and saved layout/bounds before revealing the window.
   A compact cancellable status indicator covers startup; initial failures retry.
3. Keep the renderer mounted on refresh/command errors. Refresh errors explicitly
   label retained values as stale and clear after recovery.
4. One session per window coalesces polling and invalidates responses on close.
   Lens responses also guard against out-of-order selection.
5. Load the action catalog when its menu is first opened, with local retry.
6. Report lazy-import failure and remove its pending window entry.

## Trade-offs

- Live snapshots remain uncached across windows, avoiding freshness and ownership
  complexity. The existing one-second refresh cadence is unchanged.
- Closing discards outstanding responses; it does not abort in-flight server work.
  No further polling or follow-up startup requests are issued after closure.
- Opening the action menu for the first time may briefly show its own loading
  indicator; it no longer delays the overview display.
- No Pack configuration, action semantics, simulation data, or procedure state is
  changed. Empty action catalogs are distinguished from failed catalog reads.

## Validation

- Session tests cover discovered ids, concurrent startup, overlap coalescing,
  recovery, retry, and closing during each stage of loading/refresh.
- Existing layout and rendering tests retain per-run/plant/display geometry.
- Browser verification covers title opening, pen rename, copied URL, creation,
  real Halden display opening/reopening, and on-demand plant actions.
- Supplemental Host Svelte checking passes. World retains the previously known
  50 errors and one warning in 14 unrelated UI files; no new diagnostics.
