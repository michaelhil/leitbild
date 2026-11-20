<script lang="ts">
  // The Run bar's "Simulation | Plans" switch (run-view.ts): a labelled group of two buttons, the shown view
  // pressed. At phone width it does not show; the Run's More menu offers the other view instead (App.svelte).
  import type { RunView } from './run-view.ts'

  let { shown, onswitch }: {
    shown: RunView
    onswitch: (view: RunView) => void
  } = $props()
</script>

<div class="run-view-switch" role="group" aria-label="Simulation or plans">
  <button type="button" aria-pressed={shown === 'simulation'} onclick={() => onswitch('simulation')}>Simulation</button>
  <button type="button" aria-pressed={shown === 'plans'} onclick={() => onswitch('plans')}>Plans</button>
</div>

<style>
  .run-view-switch { flex: none; display: inline-flex; gap: 0; padding: 2px; border: 1px solid #536157; border-radius: 8px; background: #1b281f; }
  /* Compact, so the Run's bar keeps one row on a 1,024 px screen beside the Workspace name and people (live check 20 Nov). */
  button { min-height: 26px; padding: 0 .45rem; border: 0; border-radius: 6px; color: #b9c6bc; background: transparent; font-size: .72rem; font-weight: 600; white-space: nowrap; }
  button:hover { color: white; background: #2b3a30; }
  button[aria-pressed='true'] { color: white; background: #3d5544; }
  button:focus-visible { outline: 2px solid var(--lb-focus-on-dark); outline-offset: 2px; }
  @media (forced-colors: active) { button[aria-pressed='true'] { outline: 2px solid Highlight; outline-offset: -2px; } }
  /* RUN_VIEW_SWITCH_NARROW (run-view.ts): the Run's More menu takes over. */
  @media (max-width: 760px) { .run-view-switch { display: none; } }
</style>
