<script lang="ts">
  import type { Edit } from '../plan/edit-schema.ts'
  import type { TimeUnit } from '../time/units.ts'
  import { jobEdits, linkEdit, type JobForm, type LinkForm } from './edit-forms.ts'
  import type { Context } from './status-text.ts'

  // Add a job (tag-out, work, or restore and test) with its hours, estimate range and crew, and a link
  // between two jobs. Tag-out before work and test after it are added by the planner itself, never by
  // hand-drawn links.
  let { context, busy = false, onPreview }: { context: Context; busy?: boolean; onPreview: (edits: readonly Edit[], label: string) => void } = $props()

  let title = $state('')
  let kind = $state<JobForm['kind']>('work')
  let equipment = $state<string[]>([])
  let inside = $state(true)
  let value = $state('')
  let unit = $state<TimeUnit>('h')
  let elapsed = $state(false)
  let low = $state('')
  let high = $state('')
  let sourceBy = $state<JobForm['sourceBy']>('assumption')
  let sourceNote = $state('')
  let crews = $state<string[]>([])
  let amount = $state('1')
  let continuous = $state(false)
  let problems = $state<readonly string[]>([])

  let from = $state('')
  let to = $state('')
  let type = $state<LinkForm['type']>('FS')
  let lag = $state('')
  let lagUnit = $state<TimeUnit>('h')
  let linkProblems = $state<readonly string[]>([])

  const toggle = (list: string[], key: string): string[] => list.includes(key) ? list.filter(item => item !== key) : [...list, key]
  const submitJob = (event: SubmitEvent) => {
    event.preventDefault()
    const built = jobEdits({ title, kind, equipment, inside, value, unit, elapsed, low, high, sourceBy, sourceNote, crews, amount, continuous }, context.inputs)
    if (!built.ok) { problems = built.problems; return }
    problems = []
    onPreview(built.edits, `Add the job “${title.trim()}”`)
  }
  const submitLink = (event: SubmitEvent) => {
    event.preventDefault()
    const built = linkEdit({ from, to, type, lag, lagUnit })
    if (!built.ok) { linkProblems = built.problems; return }
    linkProblems = []
    onPreview(built.edits, `${context.names.job(from)} before ${context.names.job(to)}`)
  }
  const linkWords = { FS: 'finishes before the second starts', SS: 'starts before the second starts', FF: 'finishes before the second finishes' } as const
</script>

<section class="authoring" aria-labelledby="jobs-form-title">
  <form class="mini-form" onsubmit={submitJob}>
    <h2 id="jobs-form-title">Add a job</h2>
    <label>What is done<input bind:value={title} placeholder="e.g. Replace the pump seal" /></label>
    <fieldset><legend>Kind</legend>
      <label class="inline"><input type="radio" bind:group={kind} value="tag-out" /> Tag-out (take out of service)</label>
      <label class="inline"><input type="radio" bind:group={kind} value="work" /> Work</label>
      <label class="inline"><input type="radio" bind:group={kind} value="test" /> Restore and return-to-service test</label>
    </fieldset>
    <fieldset><legend>{kind === 'work' ? 'Equipment it works on (at most one)' : kind === 'tag-out' ? 'Equipment it tags out' : 'Equipment it restores and tests'}</legend>
      {#each context.inputs.equipment as item (item.key)}<label class="inline"><input type="checkbox" checked={equipment.includes(item.key)} onchange={() => { equipment = toggle(equipment, item.key) }} /> {item.label}</label>{/each}
      {#if context.inputs.equipment.length === 0}<p class="hint">No equipment yet: pick it from World, or add work that is not on equipment.</p>{/if}
    </fieldset>
    {#if kind === 'work' && equipment.length > 0}<label class="inline"><input type="checkbox" bind:checked={inside} /> Needs the item tagged out (tag-out before, test after)</label>{/if}
    <div class="field-pair">
      <label>Most likely<input inputmode="decimal" bind:value={value} /></label>
      <label>Unit<select bind:value={unit}><option value="h">hours</option><option value="min">minutes</option></select></label>
    </div>
    <div class="field-pair">
      <label>Optimistic<input inputmode="decimal" bind:value={low} /></label>
      <label>Pessimistic<input inputmode="decimal" bind:value={high} /></label>
    </div>
    <label class="inline"><input type="checkbox" bind:checked={elapsed} /> Clock time (it runs on by itself, e.g. curing), not crew working time</label>
    <label>Who says so
      <select bind:value={sourceBy}><option value="assumption">My assumption, not yet confirmed</option><option value="planner">My own figure</option><option value="reference">From a reference</option></select>
    </label>
    <label>Where it comes from<input bind:value={sourceNote} /></label>
    <fieldset><legend>Done by (any one of)</legend>
      {#each context.inputs.resources as item (item.key)}<label class="inline"><input type="checkbox" checked={crews.includes(item.key)} onchange={() => { crews = toggle(crews, item.key) }} /> {item.label}</label>{/each}
      {#if context.inputs.resources.length === 0}<p class="hint">Add a crew or tool first.</p>{/if}
    </fieldset>
    <label>How many at once<input inputmode="numeric" bind:value={amount} /></label>
    <label class="inline"><input type="checkbox" bind:checked={continuous} /> Never paused over a break (e.g. a lift)</label>
    <button type="submit" disabled={busy}>Preview</button>
    {#if problems.length > 0}<ul class="problems">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
  </form>

  <form class="mini-form" onsubmit={submitLink}>
    <h2>Link two jobs</h2>
    <label>First job<select bind:value={from}><option value="">Choose…</option>{#each context.inputs.jobs as job (job.key)}<option value={job.key}>{job.title}</option>{/each}</select></label>
    <label>It<select bind:value={type}>{#each (['FS', 'SS', 'FF'] as const) as option (option)}<option value={option}>{linkWords[option]}</option>{/each}</select></label>
    <label>Second job<select bind:value={to}><option value="">Choose…</option>{#each context.inputs.jobs as job (job.key)}<option value={job.key}>{job.title}</option>{/each}</select></label>
    <div class="field-pair">
      <label>Wait between them<input inputmode="decimal" bind:value={lag} placeholder="0" /></label>
      <label>Unit<select bind:value={lagUnit}><option value="h">hours</option><option value="min">minutes</option></select></label>
    </div>
    <button type="submit" disabled={busy}>Preview</button>
    {#if linkProblems.length > 0}<ul class="problems">{#each linkProblems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
  </form>
</section>
