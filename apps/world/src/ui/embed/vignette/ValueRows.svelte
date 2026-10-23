<script lang="ts">
  import { wholeWords } from './fit-words.ts'
  import type { AlertTone } from './readout.ts'
  import type { ValueRow } from './value-rows.ts'
  import { SPARK_WINDOW_MS } from './sparkline.ts'
  import { numberText, unitSymbol } from '../../../core/observation/model.ts'
  import CriterionRow from './CriterionRow.svelte'
  import Sparkline from './Sparkline.svelte'
  import StateWord from './StateWord.svelte'

  // A values section's rows (plan v5 W4.2), one 24 px grid row each, in
  // OpenBridge's readout list, which aligns every row's value and unit: the
  // short label, giving way by whole words; the value and its unit in the
  // list's columns, framed at its alert's priority; the chip of the limit it
  // is past, only then, in a column every row keeps while one has one; its
  // rate per minute where the 30 s and 2 min slopes agree; its 10-min
  // sparkline where its reading has a series. States and criteria take the
  // whole row in their own words. The list re-aligns after each sample: it
  // only sees its rows' attributes change, and these are properties.
  let { rows, now, heading }: {
    rows: ReadonlyArray<ValueRow>
    /** The latest sample's Run time: where each sparkline ends. */
    now: number
    /** A window default's lead rows stand under their heading, which names the sparklines' window over their column. */
    heading?: string
  } = $props()

  /** OpenBridge's alert type for each priority drawn in colour; emergency is its critical level. */
  const ALERT_TYPE: Readonly<Record<AlertTone, string>> = { caution: 'caution', warning: 'warning', alarm: 'alarm', critical: 'level-critical' }
  const SPARK = { width: 56, height: 20 }
  /** The chip column, as wide as the longest chip of any row, while one has one. */
  const chipChars = $derived(Math.max(0, ...rows.map(row => (row.look.kind === 'number' ? row.look.chip?.word.length ?? 0 : 0))))

  /** The list aligns its rows' columns again once a sample's rows are drawn. */
  const aligned = (node: HTMLElement & { align?: () => void }, _rows: ReadonlyArray<ValueRow>) => {
    const align = (): void => queueMicrotask(() => node.align?.())
    align()
    return { update: align }
  }

  /** What a row's sparkline shows, in words: it has no axis. */
  const sparkText = (row: ValueRow) => (range: { readonly min: number; readonly max: number } | null, broken: boolean): string => {
    if (range === null) return `${row.label}: no record in the last 10 min`
    const symbol = unitSymbol(row.written.unit)
    const unit = symbol === '' ? '' : ` ${symbol}`
    const write = (value: number): string => numberText(value, row.written.unit, row.written.quantity, row.written.decades === true)
    const spread = range.min === range.max ? `steady at ${write(range.min)}${unit}` : `${write(range.min)} to ${write(range.max)}${unit}`
    return `${row.label}, last 10 min: ${spread}${broken ? ' · broken where nothing was recorded' : ''}`
  }
</script>

{#if heading !== undefined}
  <h2 class="row head" style:--chip={chipChars === 0 ? '0px' : `calc(${chipChars}ch + 10px)`}><span>{heading}</span><span></span><span></span><span></span><span class="unit" title="Each sparkline: the reading's last 10 min, scaled to its own range">10 min</span></h2>
{/if}
<obc-readout-list class="rows" use:aligned={rows} style:--chip={chipChars === 0 ? '0px' : `calc(${chipChars}ch + 10px)`}>
  {#each rows as row (row.ref)}
    {#if row.look.kind === 'criterion'}
      <div class="row whole"><CriterionRow look={row.look} label={row.label} /></div>
    {:else if row.look.kind === 'state'}
      <div class="row whole"><StateWord look={row.look} label={row.label} /></div>
    {:else}
      {@const look = row.look}
      <div class="row" title={look.title}>
        <span class="name"><span class="label" aria-hidden="true" use:wholeWords={row.label}></span>{#if look.sim}<span class="sim" title="Computed by the simulator only: no instrument reads it">SIM</span>{/if}</span>
        <span class="full">{row.full}</span>
        <obc-readout-list-item
          value={look.value}
          valueType={typeof look.value === 'string' ? 'text' : 'number'}
          fractionDigits={look.decimals}
          off={look.value === null}
          offText={look.text}
          unit={look.unit}
          size="small"
          stacking="trailing-unit"
          valueOptions={{ weight: look.emphasis || look.tone !== null ? 'semibold' : 'regular' }}
          dataQuality={look.doubtful ? 'low-integrity' : undefined}
          alert={look.tone === null ? false : { status: ALERT_TYPE[look.tone], type: 'regular', thickness: 'small', mode: 'acked-active', showIcon: false, showAlertCategoryIcon: false }}
        ></obc-readout-list-item>
        <span class="chip-cell">{#if look.chip !== null}<span class={`chip ${look.chip.tone ?? 'neutral'}`} title={look.chip.text}>{look.chip.word}</span>{/if}</span>
        {#if look.reason !== null}
          <!-- Outside its validity: what it waits for, beside its "—", over the rate's and the sparkline's room (W4.4). -->
          <span class="reason" title={look.reason} use:wholeWords={`(${look.reason})`}></span>
        {:else}
          <span class="rate" title={row.rate === null ? undefined : `${row.rate.startsWith('▲') ? 'Rising' : 'Falling'} ${row.rate.slice(2).replace('/min', '')} ${row.look.unit} a minute: the last 30 s and the last 2 min agree`}>{row.rate ?? ''}</span>
          {#if row.recorded}<Sparkline series={row.series} {now} windowMs={SPARK_WINDOW_MS} size={SPARK} tone={look.tone} text={sparkText(row)} doubtful={look.doubtful} />{:else}<span></span>{/if}
        {/if}
      </div>
    {/if}
  {/each}
</obc-readout-list>

<style>
  /* One row a grid row: the list's 8 px default gap (room for two alarm frames) would make each 28 px. */
  .rows { display: block; --obc-readout-list-row-gap: 0px; }
  /* Label, value and unit (the list's columns, equal on every row), chip, rate, sparkline: every row's columns line up. */
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto var(--chip) 68px 56px; align-items: center; column-gap: 4px; height: var(--row); min-width: 0; white-space: nowrap; }
  .row.whole { display: block; }
  /* The heading, as the alerts' (AlertsSection), its units over the rate's and the sparklines' columns. */
  .head { margin: 0; font-size: 12px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; overflow: hidden; }
  .head .unit { font-size: 11px; font-weight: 400; text-transform: none; letter-spacing: 0; }
  .name { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .label { flex: 1 1 0; min-width: 0; overflow: hidden; color: var(--element-neutral-color); }
  /* A value only the simulator computes (W4.4, #67): never cut, the label gives way first. */
  .sim { flex: none; padding: 0 3px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-size: 10px; font-weight: 700; line-height: 14px; letter-spacing: 0.04em; color: var(--element-active-color); }
  /* The whole label, read by assistive technology, not shown. */
  .full { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .chip-cell { display: flex; justify-content: flex-start; min-width: 0; }
  .chip { padding: 0 4px; border: 1px solid; border-radius: 3px; font-size: 11px; font-weight: 700; line-height: 16px; letter-spacing: 0.03em; }
  .chip.neutral { color: var(--element-active-color); border-color: var(--border-outline-color); }
  .chip.caution { background: var(--display-caution-fill); color: var(--display-on-caution); border-color: var(--alert-caution-color); }
  .chip.warning { background: var(--display-warning-fill); color: var(--display-on-warning); border-color: var(--alert-warning-color); }
  .chip.alarm { background: var(--display-alarm-fill); color: var(--display-on-alarm); border-color: var(--alert-alarm-color); }
  .chip.critical { background: var(--display-critical-fill); color: var(--display-on-critical); border-color: var(--alert-critical-color); }
  .reason { grid-column: 4 / 6; min-width: 0; overflow: hidden; font-size: 12px; color: var(--element-neutral-color); }
  .rate { font-size: 12px; text-align: right; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; overflow: hidden; }
</style>
