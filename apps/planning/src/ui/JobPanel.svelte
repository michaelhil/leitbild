<script lang="ts">
  import Choice from './Choice.svelte'
  import type { Edit } from '../plan/edit-schema.ts'
  import type { TimeUnit } from '../time/units.ts'
  import { crewEdit, estimateEdit, localInputValue, lockEdit, unlockEdit, type Built } from './edit-forms.ts'
  import { floatText, type NameKind, type WhyStart } from './explain-text.ts'
  import Said from './Said.svelte'
  import { durationText, quantityText, sourceMark, sourceText } from './format.ts'
  import MarkTag from './MarkTag.svelte'
  import { needsText, type DatedRow } from './model.ts'
  import { dueOf, durationView, estimateMark, ruleMark, targetMark } from './rules-text.ts'
  import type { Context } from './status-text.ts'
  import { jobMark } from './timeline-layout.ts'

  let { jobKey, context, row = undefined, scheduled = null, why = null, busy = false, onWhy, onPreview, onClose, onPick }: {
    jobKey: string
    context: Context
    row?: DatedRow | undefined
    /** The jobs of the option shown; links to jobs of a method it did not choose are left out. */
    scheduled?: ReadonlySet<string> | null
    why?: WhyStart | null
    busy?: boolean
    onWhy: (job: string) => void
    onPreview: (edits: readonly Edit[], label: string) => void
    onClose: () => void
    /** Selects a job, crew or rule named in "why it starts then". */
    onPick?: (kind: NameKind, key: string) => void
  } = $props()

  const job = $derived(context.inputs.jobs.find(item => item.key === jobKey))
  const names = $derived(context.names)
  const linkWords = { FS: 'finishes before this starts', SS: 'starts before this starts', FF: 'finishes before this finishes' } as const
  const nextWords = { FS: 'starts after this finishes', SS: 'starts after this starts', FF: 'finishes after this finishes' } as const
  // With an option shown, only links to jobs it schedules count: the other method's jobs do not exist in it.
  const inOption = (other: string) => scheduled === null || scheduled.has(other)
  const before = $derived(context.inputs.links.filter(link => link.to === jobKey && inOption(link.from)))
  const after = $derived(context.inputs.links.filter(link => link.from === jobKey && inOption(link.to)))
  const onlyWith = (other: string): string => {
    const method = context.inputs.jobs.find(item => item.key === other)?.method
    if (scheduled !== null || method === undefined) return ''
    const option = context.inputs.methods.find(item => item.key === method.choice)?.options.find(item => item.key === method.option)
    return option === undefined ? '' : ` (only with “${option.label}”)`
  }
  let crew = $state('')
  let alsoCrew = $state('')
  const crews = $derived(context.inputs.resources.map(item => ({ value: item.key, label: item.label })))
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
      <h2 id="job-title" tabindex="-1">{job.title}</h2>
      <button type="button" class="quiet" onclick={onClose}>Close</button>
    </div>
    <p><MarkTag {mark} />{#if job.equipment.length > 0}{' '}on {names.list(job.equipment, names.equipment)}{/if}{#if job.kind === 'work' && job.isolation === 'inside'}, inside its tag-out{/if}</p>

    <dl class="facts">
      <div><dt>Takes</dt><dd><MarkTag mark={value.mark} tone={value.mark.shape === '?' ? 'unknown' : value.mark.shape === '△' ? 'assumption' : value.mark.shape === '◉' ? 'world' : 'estimate'} /> {value.text}{#if value.source}<small>{value.source}</small>{/if}</dd></div>
      {#if job.minimum}<div><dt>Shortest allowed</dt><dd>{durationText(job.minimum.value, job.minimum.unit)}: {job.minimum.words}<small>Going below it needs someone's agreement.</small></dd></div>{/if}
      {#each job.needs as need, index (index)}
        <div><dt>{index === 0 ? 'Done by' : 'Also needs'}</dt><dd>{needsText([need], names.resource)}{#if need.where}<small>Only one with {attributeLabel(need.where.attribute)} at least {quantityText(need.where.atLeast, need.where.unit)} when it starts</small>{/if}</dd></div>
      {/each}
      {#if job.continuous}<div><dt>Breaks</dt><dd>Never paused over a break</dd></div>{/if}
      {#if job.notBefore}<div><dt>Not before</dt><dd>{context.format.clock(job.notBefore.at)}: {job.notBefore.words}{#if job.notBefore.source.by === 'assumption'}<small><MarkTag mark={sourceMark(job.notBefore.source)} tone="assumption" /> Depends on a promise, {context.format.clock(job.notBefore.at)}: it is planned at that time and flagged.</small>{/if}</dd></div>{/if}
      {#if dueOf(context.inputs, job.key)}
        {@const due = dueOf(context.inputs, job.key)!}
        <div><dt>Due by</dt><dd><MarkTag mark={ruleMark} tone="rule" /> {context.format.clock(due.finishBy)}: {due.words}<small><MarkTag mark={sourceMark(due.source)} />{due.source.note ? ` ${due.source.note}` : ''} A hard rule: no plan finishes it later.</small></dd></div>
      {/if}
      {#if job.target}<div><dt>Wanted finish</dt><dd><MarkTag mark={targetMark} tone="estimate" /> {context.format.clock(job.target.finishBy)}: {job.target.words}<small>A goal, not a rule: it may slip, and lateness is counted.</small></dd></div>{/if}
      {#each job.checks as check, index (index)}<div><dt>{index === 0 ? 'Ready only if' : 'and'}</dt><dd>{check.words}<small>Checked against World at read time.</small></dd></div>{/each}
      {#each before as link, index (index)}<div><dt>{index === 0 ? 'After' : ''}</dt><dd>{names.job(link.from)} {linkWords[link.type]}{lag(link)}{onlyWith(link.from)}</dd></div>{/each}
      {#each after as link, index (index)}<div><dt>{index === 0 ? 'Before' : ''}</dt><dd>{names.job(link.to)} {nextWords[link.type]}{lag(link)}{onlyWith(link.to)}</dd></div>{/each}
      {#if job.lock}<div><dt>Start fixed</dt><dd>{context.format.clock(job.lock.start)}{job.lock.words ? `: ${job.lock.words}` : ''}</dd></div>{/if}
    </dl>

    {#if row}
      <h3>Planned {context.format.range(row.start, row.finish)}</h3>
      {#if row.uses.length > 0}<p class="planned-with">With {names.list([...new Set(row.uses.map(use => use.resource))], names.resource)}{row.uses.some(use => use.purchase !== undefined) ? ', partly on bought time' : ''}.</p>{/if}
      <p class="hint">{floatText(row.float, context)}</p>
      <button type="button" disabled={busy} onclick={() => onWhy(job.key)}>Why does it start then?</button>
      {#if why}
        <div class="why">
          <p><Said parts={why.parts} {onPick} quiet /></p>
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

    <form class="mini-form" onsubmit={(event) => {
      event.preventDefault()
      send(crewEdit(job.key, crew, alsoCrew), `Change who does ${job.title}`)
    }}>
      <h3>Who does it</h3>
      {#if job.needs.length === 0}<p class="hint">No crew or tool yet: Generate needs one for its working time.</p>{/if}
      <Choice label="Done by" bind:value={crew} options={[{ value: '', label: 'Choose a crew or tool…' }, ...crews]} disabled={busy} />
      <Choice label="Also needs (optional)" bind:value={alsoCrew} options={[{ value: '', label: 'Nothing else' }, ...crews]} disabled={busy} />
      <button type="submit" disabled={busy}>Preview</button>
    </form>

    <form class="mini-form" onsubmit={(event) => { event.preventDefault(); send(estimateEdit(job.key, estimate, entryUnit(job.duration.unit), estimateBy, estimateNote), `New estimate for ${job.title}`) }}>
      <h3>Change the estimate</h3>
      <label>New most likely value ({entryUnit(job.duration.unit) === 'h' ? 'hours' : entryUnit(job.duration.unit) === 'd' ? 'days' : 'minutes'})<input inputmode="decimal" bind:value={estimate} /></label>
      <Choice label="Who says so" bind:value={estimateBy} options={[{ value: 'planner', label: `${estimateMark.word}: my own` }, { value: 'assumption', label: 'Assumption, not yet confirmed' }, { value: 'reference', label: 'From a reference' }]} />
      <label>Where it comes from<input bind:value={estimateNote} placeholder={job.duration.origin.by === 'world' ? '' : sourceText(job.duration.origin)} /></label>
      <button type="submit" disabled={busy}>Preview</button>
    </form>
    {#if problems.length > 0}<ul class="problems">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
    <p><button type="button" class="quiet" disabled={busy} onclick={() => onPreview([{ edit: 'remove', what: 'job', key: job.key }], `Remove the job “${job.title}”`)}>Remove this job…</button></p>
  </section>
{/if}
