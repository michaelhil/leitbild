<script lang="ts">
  import type { Segment } from '@oicl/connector-diagram'
  import type { Palette } from '../../displays/severity.ts'
  import type { FlowDrawing } from './flow-symbols.ts'
  import { LEGEND_PIPE, legendKeys } from './flow-legend.ts'
  import { paintLines } from './lines.ts'

  // A flow drawing's key, in the row the composer keeps under it (flow-legend.ts): each pipe look the drawing uses as
  // OpenBridge's pipe renderer draws it, then the outlines its items carry. Keys that do not fit the row drop whole.
  let { drawing, palette, zoom }: { drawing: FlowDrawing; palette: Palette; zoom: number } = $props()

  const keys = $derived(legendKeys(drawing))

  type Paint = { readonly segments: ReadonlyArray<Segment>; readonly palette: Palette; readonly zoom: number }
  const lines = (canvas: HTMLCanvasElement, params: Paint) => {
    const paint = (next: Paint): void => paintLines(canvas, LEGEND_PIPE, next.segments, next.zoom)
    paint(params)
    return { update: paint }
  }
</script>

{#if keys.length > 0}
  <p class="legend" aria-label="Key">
    {#each keys as key (key.text)}
      <span class="key">
        {#if key.kind === 'pipe'}<canvas use:lines={{ segments: key.segments, palette, zoom }} aria-hidden="true"></canvas>
        {:else if key.kind === 'command'}<span class="command" aria-hidden="true">CMD</span>
        {:else}<span class="expected" aria-hidden="true"></span>{/if}
        {key.text}
      </span>
    {/each}
  </p>
{/if}

<style>
  .legend { display: flex; flex-wrap: wrap; align-items: center; column-gap: 16px; height: var(--row); margin: 0; overflow: hidden; font-size: 12px; line-height: var(--row); color: var(--element-neutral-color); white-space: nowrap; }
  .key { display: inline-flex; align-items: center; gap: 6px; height: var(--row); }
  canvas { display: block; }
  /* As the drawing outlines an item that does not follow a command: its CMD word bold, a neutral hairline round it. */
  .command { padding: 0 4px; border: 1px solid var(--element-neutral-color); border-radius: 4px; line-height: 16px; font-weight: 700; color: var(--element-active-color); }
  /* As it outlines an item whose alerts are all expected. */
  .expected { width: 20px; height: 12px; box-sizing: border-box; border: 1px dashed var(--element-neutral-color); border-radius: 4px; }
</style>
