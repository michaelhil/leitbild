<script lang="ts">
  import type { ComposedDisplayPen } from '../../../packs/process-plant/displays/compose.ts'
  import { composedTrendLegendHeight } from '../../../packs/process-plant/displays/composition.ts'
  import { formatQuantity, marginText, nearestThresholdMargin } from '../../../packs/process-plant/displays/display-text.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { displayName, fitName, penStroke, roleLabel } from './pen-style.ts'
  import { panelFont, textMeasure } from './text-measure.ts'
  import { activeThreshold, limitAhead, movingAwayFromLimits, rateChange, ratePerMinute, rateText, rateWindowMs, returningText, timeToThresholdText } from './panel-presenters.ts'
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

  // A name takes what the swatch and column gaps (the CSS below) and room for
  // a value, a limit state and a readable rate leave of the legend's width,
  // dropping whole words to fit.
  const RESERVED = 22 + 4 * 10 + 80 + 220 + 100
  const BADGE_WIDTH = 64
  const measureName = textMeasure(panelFont(12))
  let width = $state(0)
  const named = (name: string, badges: number): string => width === 0 ? name
    : fitName(name, text => measureName(text) <= Math.max(120, width - RESERVED) - badges * BADGE_WIDTH)
</script>

<ul class="legend" style={`height:${composedTrendLegendHeight(pens.length)}px`} bind:clientWidth={width}>
  {#each pens as pen, index (pen.path)}
    {@const entry = sampled(String(pen.path))}
    {@const value = entry?.value}
    {@const points = series.get(String(pen.path)) ?? []}
    {@const liveOnly = live || historyMissing.has(String(pen.path))}
    {@const inAlarm = activeThreshold(pen.thresholds, activeRuleIds)}
    {@const rate = live ? null : ratePerMinute(points, windowMs)}
    {@const margin = typeof value === 'number' ? (live ? nearestThresholdMargin(value, pen.thresholds) : limitAhead(value, rate, pen.thresholds)) : null}
    {@const away = typeof value === 'number' && !live ? movingAwayFromLimits(value, rate, pen.thresholds) : null}
    {@const back = typeof value === 'number' && inAlarm !== null ? returningText(value, rate, inAlarm, pen.unit) : ''}
    {@const limited = pen.thresholds.some(threshold => threshold.kind !== 'control')}
    <li>
      {#if live}<span class="swatch live" aria-hidden="true"></span>{:else}<svg class="swatch" width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" style={penStroke(pen.role, index)} /></svg>{/if}
      <span class="name" title={`${displayName(pen)} · ${pen.label} · ${roleLabel[pen.role]}${pen.command ? ' · operator or automation demand, not a measured state' : ''}${live ? ' · not recorded by this Run: current value only' : liveOnly ? ' · no recorded history in this window' : ''}`}>{#if live}<span class="badge">not recorded</span>{/if}{named(displayName(pen), (live ? 1 : 0) + (pen.command ? 1 : 0))}{#if pen.command}<span class="badge">demand</span>{/if}</span>
      <span class="value">{typeof value === 'number' ? formatQuantity(value, pen.unit) : typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : '—'}</span>
      <span class="state">
        {#if inAlarm !== null}<AlarmChip threshold={inAlarm} />{/if}
        {#if back !== ''}<span>{back}</span>{:else if margin !== null}<span class:beyond={margin.margin < 0}>{marginText(margin, pen.unit)}{#if typeof value === 'number' && margin.margin >= 0}{@const eta = timeToThresholdText(value, rate, margin.threshold)}{eta === '' ? '' : ` · ${eta}`}{/if}</span>{:else if away !== null}<span>no {away === 'rising' ? 'HI' : 'LO'} limit ahead</span>{:else if !limited && typeof value === 'number'}<span>no I&amp;C limit</span>{/if}
        {#if entry?.quality === 'outside-hard-range'}<span class="beyond">outside range</span>{/if}
      </span>
      <span class="rate">{typeof value === 'number' && !live ? rateText(rate, value, pen.unit, { windowMs, change: rateChange(points, windowMs, value) }) : ''}{liveOnly && !live ? ' · live only' : ''}</span>
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
  .badge { margin: 0 5px; padding: 0 4px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
  .demand { margin-left: 5px; padding: 0 4px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  .state { display: flex; align-items: center; gap: 6px; }
  .swatch.live { font-size: 9.5px; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
  .name { font-size: 12px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .value { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
  .state, .rate { font-size: 11px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .rate { overflow: hidden; text-overflow: ellipsis; }
  .beyond { color: var(--alert-caution-color); font-weight: 600; }
</style>
