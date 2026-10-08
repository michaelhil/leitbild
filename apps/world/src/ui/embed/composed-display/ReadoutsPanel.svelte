<script lang="ts">
  import type { ComposedReadoutsPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { marginText, nearestThresholdMargin } from './panel-presenters.ts'
  import { unitLabel, valueDigits } from './trend-geometry.ts'
  import './openbridge.ts'

  let { panel, latest }: { panel: ComposedReadoutsPanel; latest: ComposedDisplaySample | undefined } = $props()

  const sampled = (path: string) => latest?.values.find(entry => entry.path === path)
  const rows = $derived(Math.ceil(panel.pens.length / composedDisplayLayout.readoutsPerRow))
</script>

<ul class="readouts" style={`height:${rows * composedDisplayLayout.readoutsRow}px;grid-template-columns:repeat(${composedDisplayLayout.readoutsPerRow}, minmax(0, 1fr));`}>
  {#each panel.pens as pen (pen.path)}
    {@const entry = sampled(String(pen.path))}
    {@const value = entry?.value}
    {@const margin = typeof value === 'number' ? nearestThresholdMargin(value, pen.thresholds) : null}
    <li class:primary={pen.role === 'primary'} title={`${pen.label} · ${pen.role}`}>
      <span class="tag">{pen.tagId ?? pen.path}</span>
      {#if typeof value === 'boolean'}
        <span class="state"><obc-readout value={value ? 'yes' : 'no'} valueType="text" size="small"></obc-readout><span class="label">{pen.label.toLowerCase()}</span></span>
      {:else}
        <obc-readout
          value={typeof value === 'number' ? value : null}
          off={typeof value !== 'number'}
          offText="—"
          unit={unitLabel(pen.unit)}
          fractionDigits={typeof value === 'number' ? valueDigits(value) : 0}
          size="small"
        ></obc-readout>
      {/if}
      {#if margin !== null}
        <span class="margin" class:beyond={margin.margin < 0}>{marginText(margin, unitLabel(pen.unit))}</span>
      {:else if entry?.quality === 'outside-hard-range'}
        <span class="margin beyond">outside range</span>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .readouts { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px 12px; overflow: hidden; }
  li { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding: 2px 8px; border-left: 2px solid var(--border-divider-color); }
  li.primary { border-left-color: var(--element-active-color); }
  .tag { font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .state { display: flex; align-items: baseline; gap: 6px; }
  .label { font-size: 11px; color: var(--element-neutral-color); }
  .margin { font-size: 11px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .margin.beyond { color: var(--alert-caution-color); font-weight: 600; }
</style>
