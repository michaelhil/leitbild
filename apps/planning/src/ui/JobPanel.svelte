<script lang="ts">
  import type { Edit } from '../plan/edit-schema.ts'
  import type { TimeUnit } from '../time/units.ts'
  import { estimateEdit, localInputValue, lockEdit, unlockEdit, type Built } from './edit-forms.ts'
  import { floatText, type WhyStart } from './explain-text.ts'
  import { durationText, quantityText, sourceMark, sourceText } from './format.ts'
  import MarkTag from './MarkTag.svelte'
  import type { DatedRow } from './model.ts'
  import { durationView, estimateMark } from './rules-text.ts'
  import type { Context } from './status-text.ts'
  import { jobMark } from './timeline-layout.ts'

  let { jobKey, context, row = undefined, why = null, busy = false, onWhy, onPreview, onClose }: {
    jobKey: string
    context: Context
    row?: DatedRow | undefined
    why?: WhyStart | null
    busy?: boolean
    onWhy: (job: string) => void
    onPreview: (edits: readonly Edit[], label: string) => void
    onClose: () => void
  } = $props()

  const job = $derived(context.inputs.jobs.find(item => item.key === jobKey))
  const names = $derived(context.names)
  const linkWords = { FS: 'finishes before this starts', SS: 'starts before this starts', FF: 'finishes before this finishes' } as const
  const nextWords = { FS: 'starts after this finishes', SS: 'starts after this starts', FF: 'finishes after this finishes' } as const
  const before = $derived(context.inputs.links.filter(link => link.to === jobKey))
  const after = $derived(context.inputs.links.filter(link => link.from === jobKey))
  const lag = (link: { lag: { value: number; unit: TimeUnit } }) => link.lag.value === 0 ? '' : `, with ${durationText(link.lag.value, link.lag.unit)} between`

  const attributeLabel = (key: string) => context.inputs.resources.flatMap(resource => resource.attributes).find(attribute => attribute.key === key)?.label ?? 'the needed property'
  // A job kept in seconds (a 30 s grid) is re-estimated in minutes: people do not type seconds.
  const entryUnit = (unit: TimeUnit): TimeUnit => unit === 's' ? 'min' : unit

  let lockAt = $state('')
  let estimate = $state('')
  let estimateBy = $state<'planner' | 'assumption' | 'reference'>('planner')
  let estimateNote = $state('')
  let problems = $state<readonly string[]>([])

  const send = (built: Built, label: string) => {
    if (!built.ok) { problems = built.problems; return }
    problems = []
    onPreview(built.edits, label)
  }
</script>

{#if job}
  {@const mark = jobMark(job.kind)}
  {@const value = durationView(job, context.inputs.world.facts, context.format)}
  <section class="job-panel" aria-labelledby="job-title">
    <div class="panel-heading">
      <h2 id="job-title">{job.title}</h2>
      <button type="button" class="quiet" onclick={onClose}>Close</button>
    </div>
    <p><MarkTag {mark} />{#if job.equipment.length > 0} on {names.list(job.equipment, names.equipment)}{/if}{#if job.kind === 'work' && job.isolation === 'inside'}, inside its tag-out{/if}</p>

    <dl class="facts">
      <div><dt>Takes</dt><dd><MarkTag mark={value.mark} tone={value.mark.shape === '?' ? 'unknown' : value.mark.shape === '△' ? 'assumption' : value.mark.shape === '◉' ? 'world' : 'estimate'} /> {value.text}{#if value.source}<small>{value.source}</small>{/if}</dd></div>
      {#if job.minimum}<div><dt>Shortest allowed</dt><dd>{durationText(job.minimum.value, job.minimum.unit)}: {job.minimum.words}<small>Going below it needs someone's agreement.</small></dd></div>{/if}
      {#each job.needs as need, index (index)}
        <div><dt>{index === 0 ? 'Done by' : 'Also needs'}</dt><dd>{need.amount > 1 ? `${need.amount} of ` : ''}{names.list(need.anyOf, names.resource)}{#if need.where}<small>Only one with {attributeLabel(need.where.attribute)} at least {quantityText(need.where.atLeast, need.where.unit)} when it starts</small>{/if}</dd></div>
      {/each}
      {#if job.continuous}<div><dt>Breaks</dt><dd>Never paused over a break</dd></div>{/if}
      {#if job.notBefore}<div><dt>Not before</dt><dd>{context.format.clock(job.notBefore.at)}: {job.notBefore.words}{#if job.notBefore.source.by === 'assumption'}<small><MarkTag mark={sourceMark(job.notBefore.source)} tone="assumption" /> Depends on a promise, {context.format.clock(job.notBefore.at)}: it is planned at that time and flagged.</small>{/if}</dd></div>{/if}
      {#if job.target}<div><dt>Wanted finish</dt><dd>{context.format.clock(job.target.finishBy)}: {job.target.words}<small>A goal, not a rule.</small></dd></div>{/if}
      {#each job.checks as check, index (index)}<div><dt>{index === 0 ? 'Ready only if' : 'and'}</dt><dd>{check.words}<small>Checked against World at read time.</small></dd></div>{/each}
      {#each before as link, index (index)}<div><dt>{index === 0 ? 'After' : ''}</dt><dd>{names.job(link.from)} {linkWords[link.type]}{lag(link)}</dd></div>{/each}
      {#each after as link, index (index)}<div><dt>{index === 0 ? 'Before' : ''}</dt><dd>{names.job(link.to)} {nextWords[link.type]}{lag(link)}</dd></div>{/each}
      {#if job.lock}<div><dt>Start fixed</dt><dd>{context.format.clock(job.lock.start)}{job.lock.words ? `: ${job.lock.words}` : ''}</dd></div>{/if}
    </dl>

    {#if row}
      <h3>Planned {context.format.range(row.start, row.finish)}</h3>
      <p class="hint">{floatText(row.float, context)}</p>
      <button type="button" disabled={busy} onclick={() => onWhy(job.key)}>Why does it start then?</button>
      {#if why}
        <div class="why">
          <p>{why.sentence}</p>
          {#if why.joint}<p class="hint">These are joint causes: easing only one of them does not move the job.</p>{/if}
        </div>
      {/if}
    {:else}
      <p class="hint">Not planned yet: generate a plan to see when it starts and why.</p>
    {/if}

    <form class="mini-form" onsubmit={(event) => { event.preventDefault(); send(job.lock ? unlockEdit(job.key) : lockEdit(job.key, lockAt || (row ? localInputValue(row.start, context.format.zone) : ''), context.format.zone), job.lock ? `Let ${job.title} move again` : `Fix the start of ${job.title}`) }}>
      <h3>{job.lock ? 'Let it move again' : 'Fix its start'}</h3>
      {#if !job.lock}
        <label>Start at ({context.format.zone})<input type="datetime-local" bind:value={lockAt} placeholder={row ? localInputValue(row.start, context.format.zone) : ''} /></label>
      {/if}
      <button type="submit" disabled={busy}>Preview</button>
    </form>

    <form class="mini-form" onsubmit={(event) => { event.preventDefault(); send(estimateEdit(job.key, estimate, entryUnit(job.duration.unit), estimateBy, estimateNote), `New estimate for ${job.title}`) }}>
      <h3>Change the estimate</h3>
      <label>New most likely value ({entryUnit(job.duration.unit) === 'h' ? 'hours' : entryUnit(job.duration.unit) === 'd' ? 'days' : 'minutes'})<input inputmode="decimal" bind:value={estimate} /></label>
      <label>Who says so
        <select bind:value={estimateBy}>
          <option value="planner">{estimateMark.word}: my own</option>
          <option value="assumption">Assumption, not yet confirmed</option>
          <option value="reference">From a reference</option>
        </select>
      </label>
      <label>Where it comes from<input bind:value={estimateNote} placeholder={job.duration.origin.by === 'world' ? '' : sourceText(job.duration.origin)} /></label>
      <button type="submit" disabled={busy}>Preview</button>
    </form>
    {#if problems.length > 0}<ul class="problems">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
    <p><button type="button" class="quiet" disabled={busy} onclick={() => onPreview([{ edit: 'remove', what: 'job', key: job.key }], `Remove the job “${job.title}”`)}>Remove this job…</button></p>
  </section>
{/if}
