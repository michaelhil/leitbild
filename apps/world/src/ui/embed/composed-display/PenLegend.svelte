<script lang="ts">
  import type { ComposedDisplayPen } from '../../../packs/process-plant/displays/compose.ts'
  import { composedTrendLegendHeight } from '../../../packs/process-plant/displays/composition.ts'
  import { formatQuantity, marginText, nearestThresholdMargin } from '../../../packs/process-plant/displays/display-text.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { displayName, penStroke, roleLabel } from './pen-style.ts'
  import { activeThreshold, limitAhead, movingAwayFromLimits, rateChange, ratePerMinute, rateText, rateWindowMs, timeToThresholdText } from './panel-presenters.ts'
  import type { TrendPoint } from './trend-geometry.ts'
  import AlarmChip from './AlarmChip.svelte'

  // One row per pen, columns aligned: what it is, its value, how close it is
  // to acting I&C (or the active alarm), and where it is heading. Live rows are
  // signals the Run does not record: current value only, no swatch.
  let { pens, horizonMs, live = false, latest, series, historyMissing, activeRuleIds }: {
    pens: ReadonlyArray<ComposedDisplayPen>
    horizonMs: number
    live?: boolean
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
    {@const liveOnly = live || historyMissing.has(String(pen.path))}
    {@const inAlarm = activeThreshold(pen.thresholds, activeRuleIds)}
    {@const rate = live ? null : ratePerMinute(points, windowMs)}
    {@const margin = typeof value === 'number' ? (live ? nearestThresholdMargin(value, pen.thresholds) : limitAhead(value, rate, pen.thresholds)) : null}
    {@const away = typeof value === 'number' && !live ? movingAwayFromLimits(value, rate, pen.thresholds) : null}
    <li>
      {#if live}<span class="swatch live" aria-hidden="true">now</span>{:else}<svg class="swatch" width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" style={penStroke(pen.role, index)} /></svg>{/if}
      <span class="name" title={`${pen.label} · ${roleLabel[pen.role]}${pen.command ? ' · operator or automation demand, not a measured state' : ''}${live ? ' · not recorded by this Run: current value only' : liveOnly ? ' · no recorded history in this window' : ''}`}>{displayName(pen)}{#if pen.command}<span class="demand">demand</span>{/if}</span>
      <span class="value">{typeof value === 'number' ? formatQuantity(value, pen.unit) : typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : '—'}</span>
      <span class="state">
        {#if inAlarm !== null}<AlarmChip threshold={inAlarm} />{/if}
        {#if margin !== null}<span class:beyond={margin.margin < 0}>{marginText(margin, pen.unit)}{#if typeof value === 'number' && margin.margin >= 0}{@const eta = timeToThresholdText(value, rate, margin.threshold)}{eta === '' ? '' : ` · ${eta}`}{/if}</span>{:else if away !== null}<span>no {away === 'rising' ? 'HI' : 'LO'} limit ahead</span>{/if}
        {#if entry?.quality === 'outside-hard-range'}<span class="beyond">outside range</span>{/if}
      </span>
      <span class="rate">{typeof value === 'number' && !live ? rateText(rate, value, pen.unit, { windowMs, change: rateChange(points, windowMs, value) }) : ''}{live ? 'not recorded · current value' : liveOnly ? ' · live only' : ''}</span>
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
  .demand { margin-left: 5px; padding: 0 4px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  .state { display: flex; align-items: center; gap: 6px; }
  .swatch.live { font-size: 9.5px; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
  .name { font-size: 12px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .value { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
  .state, .rate { font-size: 11px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .rate { overflow: hidden; text-overflow: ellipsis; }
  .beyond { color: var(--alert-caution-color); font-weight: 600; }
</style>
