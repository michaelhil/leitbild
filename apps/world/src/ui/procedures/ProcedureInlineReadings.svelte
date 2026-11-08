<script lang="ts">
  import { untrack } from 'svelte'
  import type { ProcedureTag, SimulationRunId } from '../../core/model/index.ts'
  import { sparkline, sparklineScale } from '../sparkline.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import { readProcedureTagHistory, type ProcedureTrendPoint } from './procedure-client.ts'
  import { procedureInlineLayout, procedureInlineValue, procedureNumberText, type ProcedureIndication } from './procedure-view.ts'

  // A judgement line's readings on the line, with no colour: one column per piece of equipment
  // where its tags form a grid, each number with its recent trend on one scale per row.

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly plantId: string
    readonly tagIds: ReadonlyArray<string>
    readonly tags: ReadonlyArray<ProcedureTag>
    readonly indications: ReadonlyArray<ProcedureIndication>
    /** Simulation time now, in epoch ms. */
    readonly now: number | undefined
    readonly pathFor: (tagId: string) => string | undefined
    readonly openTag: (tagId: string) => void
  }

  let { simulationRunId, plantId, tagIds, tags, indications, now, pathFor, openTag }: Props = $props()

  const WINDOW_MS = 300_000
  /** The Historian holds an unchanged value at most this long, so a line breaks beyond it. */
  const HOLD_MS = 90_000
  const READ_EVERY_MS = 5_000
  const SIZE = { width: 64, height: 18 } as const

  const layout = $derived(procedureInlineLayout(tagIds, tags))
  let histories = $state.raw<ReadonlyMap<string, ReadonlyArray<ProcedureTrendPoint>>>(new Map())
  let historyError = $state<string | null>(null)
  let disposed = false

  // The tags with a number to trend. They are known once the first indications arrive, and that read starts the trend.
  const numeric = $derived(tagIds.filter(tagId => typeof indications.find(item => item.tagId === tagId)?.value === 'number'))
  const numericKey = $derived(numeric.join(' '))
  const refresh = async (): Promise<void> => {
    if (now === undefined) return
    const to = now
    try {
      const reads = await Promise.all(numeric.flatMap(tagId => {
        const path = pathFor(tagId)
        return path === undefined ? [] : [readProcedureTagHistory(simulationRunId, plantId, path, { from: to - WINDOW_MS - HOLD_MS, to }).then(points => [tagId, points] as const)]
      }))
      if (!disposed) {
        histories = new Map(reads)
        historyError = null
      }
    } catch (error) {
      if (!disposed) historyError = error instanceof Error ? error.message : String(error)
    }
  }

  $effect(() => {
    if (numericKey !== '') untrack(() => void refresh())
  })

  runOnMount(() => {
    const timer = setInterval(() => { void refresh() }, READ_EVERY_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  })

  const rowRange = (rowTags: ReadonlyArray<string | null>): { readonly min: number; readonly max: number } | undefined => {
    if (now === undefined) return undefined
    const start = now - WINDOW_MS
    const values = rowTags.flatMap(tagId => (tagId === null ? [] : histories.get(tagId) ?? []).filter(point => point.t >= start && point.t <= now!).map(point => point.v))
    return values.length === 0 ? undefined : { min: Math.min(...values), max: Math.max(...values) }
  }
</script>

<div class="procedure-inline-readings" style={layout.heads.length > 0 ? `--columns: ${layout.heads.length}` : '--columns: 1'}>
  {#each layout.heads as head (head)}<span class="procedure-inline-head">{head}</span>{/each}
  {#each layout.rows as row (row.label)}
    {@const range = rowRange(row.tagIds)}
    {@const unit = indications.find(item => item.tagId !== undefined && item.unit !== undefined && row.tagIds.includes(item.tagId))?.unit}
    <span class="procedure-inline-label">
      <span>{row.label}</span>
      {#if range}<span>last {WINDOW_MS / 60_000} min: {procedureNumberText(range.min, unit)} to {procedureNumberText(range.max, unit)}</span>{/if}
    </span>
    {#each row.tagIds as tagId, index (tagId ?? index)}
      <span class="procedure-inline-cell">
        {#if tagId !== null}
          {@const cell = procedureInlineValue(tagId, tags, indications, now)}
          {@const points = histories.get(tagId)}
          {@const line = points !== undefined && now !== undefined ? sparkline(points, now, WINDOW_MS, SIZE, HOLD_MS, undefined, range ? sparklineScale(range) : undefined) : null}
          <button type="button" class="procedure-inline-value" class:stale={cell.stale} title={cell.note} onclick={() => openTag(tagId)}>{cell.value}</button>
          {#if line}
            <svg class="procedure-inline-trend" viewBox="0 0 {SIZE.width} {SIZE.height}" width={SIZE.width} height={SIZE.height} role="img" aria-label="{row.label}: last {WINDOW_MS / 60_000} min, {procedureNumberText(line.range.min, unit)} to {procedureNumberText(line.range.max, unit)}">
              <path d={line.path} />
              {#if line.end}<circle cx={line.end.x} cy={line.end.y} r="2" />{/if}
            </svg>
          {/if}
          {#if cell.note}<small class="procedure-inline-note">{cell.note}</small>{/if}
        {/if}
      </span>
    {/each}
  {/each}
  {#if historyError}<small class="procedure-inline-note">No trend: {historyError}</small>{/if}
</div>
