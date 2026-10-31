<script lang="ts">
  import type { StateChipLook } from './state-chip.ts'

  // An own state's chip on the title row (state-chip.ts): a token-styled chip,
  // never cut. Where a press can open what decides the state, it is a button
  // that says so by its pointer, its focus ring and its title, never by a
  // button's look that would compete with its status colour (the old chips'
  // rule, HF-21).
  let { look, open }: { look: StateChipLook; open: (() => void) | null } = $props()
</script>

{#if open === null}
  <span class={['chip', look.tone, look.mark, { emphasis: look.emphasis, doubtful: look.doubtful }]} role="listitem" title={look.title} aria-label={look.label}>{look.text}</span>
{:else}
  <span class="item" role="listitem">
    <button type="button" class={['chip', look.tone, look.mark, { emphasis: look.emphasis, doubtful: look.doubtful }]} title={`${look.title}\nOpens what decides it.`} aria-label={`${look.label}; open what decides it`} onclick={open}>{look.text}</button>
  </span>
{/if}

<style>
  .item { display: inline-flex; flex: none; }
  .chip { flex: none; margin: 0; padding: 0 4px; border: 1px solid var(--border-outline-color); border-radius: 3px; background: none; color: var(--element-active-color); font: inherit; font-size: 11px; font-weight: 700; line-height: 18px; letter-spacing: 0.02em; white-space: nowrap; }
  button.chip { cursor: pointer; }
  button.chip:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 1px; }
  .chip.caution { background: var(--display-caution-fill); color: var(--display-on-caution); border-color: var(--alert-caution-color); }
  .chip.warning { background: var(--display-warning-fill); color: var(--display-on-warning); border-color: var(--alert-warning-color); }
  .chip.alarm { background: var(--display-alarm-fill); color: var(--display-on-alarm); border-color: var(--alert-alarm-color); }
  .chip.unknown, .chip.outside { border-style: dashed; color: var(--element-neutral-color); }
  .chip.emphasis { border-width: 2px; padding: 0 3px; line-height: 16px; }
  /* Stale or frozen: OpenBridge's low-integrity colours, its words kept (they say what it last read). */
  .chip.doubtful { background: var(--alert-low-integrity-background-color); border-color: var(--alert-low-integrity-border-color); color: var(--element-active-color); }
</style>
