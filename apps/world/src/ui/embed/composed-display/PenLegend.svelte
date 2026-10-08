<script lang="ts">
  import type { ComposedDisplayPen } from '../../../packs/process-plant/displays/compose.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { displayName, penStroke, roleLabel } from './pen-style.ts'
  import { activeThreshold, ratePerMinute, rateText } from './panel-presenters.ts'
  import { unitLabel, valueDigits, type TrendPoint } from './trend-geometry.ts'
  import AlarmChip from './AlarmChip.svelte'

  let { pens, latest, series, historyMissing, activeRuleIds }: {
    pens: ReadonlyArray<ComposedDisplayPen>
    latest: ComposedDisplaySample | undefined
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
    historyMissing: ReadonlySet<string>
    activeRuleIds: ReadonlySet<string>
  } = $props()

  const sampled = (path: string) => latest?.values.find(entry => entry.path === path)
</script>

<ul class="legend">
  {#each pens as pen, index (pen.path)}
    {@const entry = sampled(String(pen.path))}
    {@const value = entry?.value}
    {@const liveOnly = historyMissing.has(String(pen.path))}
    {@const inAlarm = activeThreshold(pen.thresholds, activeRuleIds)}
    {@const unit = unitLabel(pen.unit)}
    <li title={`${pen.label} · ${roleLabel[pen.role]}${liveOnly ? ' · no recorded history; live since this view opened' : ''}`}>
      <svg class="swatch" width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" style={penStroke(pen.role, index)} /></svg>
      <span class="name">{displayName(pen)}</span>
      <span class="value">{typeof value === 'number' ? `${value.toFixed(valueDigits(value))} ${unit}` : '—'}</span>
      {#if inAlarm !== null}<AlarmChip threshold={inAlarm} />{/if}
      {#if typeof value === 'number'}<span class="rate">{rateText(ratePerMinute(series.get(String(pen.path)) ?? []), value, unit)}</span>{/if}
      {#if liveOnly}<span class="note">live only</span>{/if}
      {#if entry?.quality === 'outside-hard-range'}<span class="quality">outside range</span>{/if}
    </li>
  {/each}
</ul>

<style>
  .legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 2px 16px; height: 34px; align-content: center; overflow: hidden; }
  li { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .swatch { flex: none; }
  .name { font-size: 12px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; }
  .value { font-size: 13.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .rate, .note { font-size: 11px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .quality { font-size: 11px; color: var(--alert-caution-color); }
</style>
