<script lang="ts">
  import type { ComposedDisplayPen } from '../../../packs/process-plant/displays/compose.ts'
  import { composedTrendLegendHeight } from '../../../packs/process-plant/displays/composition.ts'
  import { unitLabel } from '../../../packs/process-plant/displays/display-text.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { displayName, penStroke, roleLabel } from './pen-style.ts'
  import { activeThreshold, marginText, nearestThresholdMargin, rateChange, ratePerMinute, rateText, rateWindowMs } from './panel-presenters.ts'
  import { valueDigits, type TrendPoint } from './trend-geometry.ts'
  import AlarmChip from './AlarmChip.svelte'

  // One row per pen, columns aligned: what it is, its value, how close it is
  // to acting I&C (or the active alarm), and where it is heading.
  let { pens, horizonMs, latest, series, historyMissing, activeRuleIds }: {
    pens: ReadonlyArray<ComposedDisplayPen>
    horizonMs: number
    latest: ComposedDisplaySample | undefined
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
    historyMissing: ReadonlySet<string>
    activeRuleIds: ReadonlySet<string>
  } = $props()

  const sampled = (path: string) => latest?.values.find(entry => entry.path === path)
  const windowMs = $derived(rateWindowMs(horizonMs))
</script>

<ul class="legend" style={`height:${composedTrendLegendHeight(pens.length)}px`}>
  {#each pens as pen, index (pen.path)}
    {@const entry = sampled(String(pen.path))}
    {@const value = entry?.value}
    {@const points = series.get(String(pen.path)) ?? []}
    {@const liveOnly = historyMissing.has(String(pen.path))}
    {@const inAlarm = activeThreshold(pen.thresholds, activeRuleIds)}
    {@const margin = typeof value === 'number' && inAlarm === null ? nearestThresholdMargin(value, pen.thresholds) : null}
    {@const unit = unitLabel(pen.unit)}
    <li>
      <svg class="swatch" width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" style={penStroke(pen.role, index)} /></svg>
      <span class="name" title={`${pen.label} · ${roleLabel[pen.role]}${liveOnly ? ' · no recorded history; live since this view opened' : ''}`}>{displayName(pen)}</span>
      <span class="value">{typeof value === 'number' ? `${value.toFixed(valueDigits(value))} ${unit}` : '—'}</span>
      <span class="state">
        {#if inAlarm !== null}<AlarmChip threshold={inAlarm} />{:else if margin !== null}<span class:beyond={margin.margin < 0}>{marginText(margin, unit)}</span>{/if}
        {#if entry?.quality === 'outside-hard-range'}<span class="beyond">outside range</span>{/if}
      </span>
      <span class="rate">{typeof value === 'number' ? rateText(ratePerMinute(points, windowMs), value, unit, { windowMs, change: rateChange(points, windowMs, value) }) : ''}{liveOnly ? ' · live only' : ''}</span>
    </li>
  {/each}
</ul>

<style>
  .legend {
    list-style: none; margin: 0; padding: 4px 0 0; overflow: hidden;
    display: grid; grid-template-columns: 22px max-content max-content max-content minmax(0, 1fr);
    grid-auto-rows: 16px; column-gap: 10px; align-items: center;
  }
  li { display: contents; }
  .name { font-size: 12px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .value { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
  .state, .rate { font-size: 11px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .rate { overflow: hidden; text-overflow: ellipsis; }
  .beyond { color: var(--alert-caution-color); font-weight: 600; }
</style>
