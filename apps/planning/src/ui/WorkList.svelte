<script lang="ts">
  import { floatText } from './explain-text.ts'
  import MarkTag from './MarkTag.svelte'
  import type { DatedRow } from './model.ts'
  import { durationView } from './rules-text.ts'
  import type { Context } from './status-text.ts'
  import { jobMark } from './timeline-layout.ts'

  // Every job, in schedule order once a plan exists: kind, what it is on, its estimate (or unknown),
  // when it is planned, its float and who does it.
  let { context, rows, selected = null, onSelect }: { context: Context; rows: readonly DatedRow[]; selected?: string | null; onSelect: (job: string) => void } = $props()

  const entries = $derived.by(() => {
    const byJob = new Map(rows.map(row => [row.job, row]))
    const order = (key: string) => {
      const row = byJob.get(key)
      return row === undefined ? Infinity : Date.parse(row.start)
    }
    return [...context.inputs.jobs].sort((left, right) => order(left.key) - order(right.key)).map(job => {
      const row = byJob.get(job.key)
      const who = row === undefined
        ? context.names.list(job.needs.flatMap(need => need.anyOf), context.names.resource)
        : context.names.list([...new Set(row.uses.map(use => use.resource))], context.names.resource)
      return { job, row, mark: jobMark(job.kind), estimate: durationView(job, context.inputs.world.facts, context.format), who }
    })
  })
  const toneOf = (shape: string) => shape === '?' ? 'unknown' : shape === '△' ? 'assumption' : shape === '◉' ? 'world' : 'estimate'
</script>

<section class="work-list" aria-labelledby="work-title">
  <h2 id="work-title">Work</h2>
  {#if entries.length === 0}
    <p class="hint">No jobs yet.</p>
  {:else}
    <ul>
      {#each entries as entry (entry.job.key)}
        <li class:selected={entry.job.key === selected}>
          <button type="button" class="work-row" onclick={() => onSelect(entry.job.key)}>
            <span class="work-title"><span aria-hidden="true">{entry.mark.shape}</span> <span class="sr-only">{entry.mark.word}:</span> {entry.job.title}</span>
            <span class="work-meta">
              {#if entry.job.equipment.length > 0}<span>{context.names.list(entry.job.equipment, context.names.equipment)}</span>{/if}
              <span>{entry.who || 'No crew or tool yet'}</span>
            </span>
            <span class="work-estimate"><MarkTag mark={entry.estimate.mark} tone={toneOf(entry.estimate.mark.shape)} /> {entry.estimate.text}{#if entry.estimate.source}<small>{entry.estimate.source}</small>{/if}</span>
            <span class="work-when">
              {#if entry.row}{context.format.range(entry.row.start, entry.row.finish)}{:else}Not planned yet{/if}
              {#if entry.job.lock}<span class="locked"> · start fixed</span>{/if}
            </span>
            {#if entry.row}<span class="work-float">{floatText(entry.row.float, context)}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
