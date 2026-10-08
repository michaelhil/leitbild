<script lang="ts">
  import type { ComposedReadoutsPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { activeThreshold, marginText, nearestThresholdMargin } from './panel-presenters.ts'
  import { displayName } from './pen-style.ts'
  import { unitLabel } from '../../../packs/process-plant/displays/display-text.ts'
  import { valueDigits } from './trend-geometry.ts'
  import AlarmChip from './AlarmChip.svelte'
  import './openbridge.ts'

  let { panel, latest, activeRuleIds }: {
    panel: ComposedReadoutsPanel
    latest: ComposedDisplaySample | undefined
    activeRuleIds: ReadonlySet<string>
  } = $props()

  const sampled = (path: string) => latest?.values.find(entry => entry.path === path)
  const rows = $derived(Math.ceil(panel.pens.length / composedDisplayLayout.readoutsPerRow))
</script>

<ul class="readouts" style={`height:${rows * composedDisplayLayout.readoutsRow}px;grid-template-columns:repeat(${composedDisplayLayout.readoutsPerRow}, minmax(0, 1fr));`}>
  {#each panel.pens as pen (pen.path)}
    {@const entry = sampled(String(pen.path))}
    {@const value = entry?.value}
    {@const margin = typeof value === 'number' ? nearestThresholdMargin(value, pen.thresholds) : null}
    {@const inAlarm = activeThreshold(pen.thresholds, activeRuleIds)}
    <li class:primary={pen.role === 'primary'} title={`${pen.label} · ${pen.role}`}>
      <span class="name">{displayName(pen)}{#if inAlarm !== null}&nbsp;<AlarmChip threshold={inAlarm} />{/if}</span>
      {#if typeof value === 'boolean'}
        <span class="state">{value ? pen.label.toUpperCase() : `NOT ${pen.label.toUpperCase()}`}</span>
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
  .name { font-size: 11.5px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .state { font-size: 15px; font-weight: 700; letter-spacing: 0.02em; padding: 6px 0; }
  .margin { font-size: 11px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .margin.beyond { color: var(--alert-caution-color); font-weight: 600; }
</style>
