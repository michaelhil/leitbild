<script lang="ts">
  import Choice from './Choice.svelte'
  import type { Edit } from '../plan/edit-schema.ts'
  import type { TimeUnit } from '../time/units.ts'
  import { ruleEdit, type RuleForm } from './edit-forms.ts'
  import type { Context } from './status-text.ts'

  // A hard rule in the planner's words: protected equipment, "at least k of these in service", or a
  // longest outage for a function group. Previewed before it is saved.
  let { context, busy = false, onPreview }: { context: Context; busy?: boolean; onPreview: (edits: readonly Edit[], label: string) => void } = $props()

  let kind = $state<RuleForm['kind']>('keep-in-service')
  let words = $state('')
  let sourceBy = $state<RuleForm['sourceBy']>('planner')
  let sourceNote = $state('')
  let equipment = $state<string[]>([])
  let members = $state<string[]>([])
  let atLeast = $state('1')
  let group = $state('')
  let limit = $state('')
  let limitUnit = $state<TimeUnit>('h')
  let job = $state('')
  let finishBy = $state('')
  let problems = $state<readonly string[]>([])

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const built = ruleEdit({ kind, words, sourceBy, sourceNote, equipment, members, atLeast, group, limit, limitUnit, job, finishBy }, context.inputs)
    if (!built.ok) { problems = built.problems; return }
    problems = []
    onPreview(built.edits, `Add the rule “${words.trim()}”`)
  }
  const toggle = (list: string[], key: string): string[] => list.includes(key) ? list.filter(item => item !== key) : [...list, key]
</script>

<form class="mini-form" onsubmit={submit}>
  <h3>Add a rule</h3>
  <fieldset>
    <legend>Kind of rule</legend>
    <label class="inline"><input type="radio" bind:group={kind} value="keep-in-service" /> Keep at least some of these in service</label>
    <label class="inline"><input type="radio" bind:group={kind} value="protected" /> Never touch this equipment</label>
    <label class="inline"><input type="radio" bind:group={kind} value="span-limit" /> Longest outage for a function group</label>
    <label class="inline"><input type="radio" bind:group={kind} value="due" /> A job must be finished by a time (a hard deadline, not a wish)</label>
  </fieldset>
  <label>The rule in your words<input bind:value={words} placeholder="e.g. One of these two always available" /></label>
  {#if kind === 'protected'}
    <fieldset><legend>Equipment never tagged, worked or tested</legend>
      {#each context.inputs.equipment as item (item.key)}<label class="inline"><input type="checkbox" checked={equipment.includes(item.key)} onchange={() => { equipment = toggle(equipment, item.key) }} /> {item.label}</label>{/each}
      {#if context.inputs.equipment.length === 0}<p class="hint">Pick equipment from World first.</p>{/if}
    </fieldset>
  {:else if kind === 'keep-in-service'}
    <fieldset><legend>Items or crews that back each other up</legend>
      {#each context.inputs.equipment as item (item.key)}<label class="inline"><input type="checkbox" checked={members.includes(item.key)} onchange={() => { members = toggle(members, item.key) }} /> {item.label}</label>{/each}
      {#each context.inputs.resources as item (item.key)}<label class="inline"><input type="checkbox" checked={members.includes(item.key)} onchange={() => { members = toggle(members, item.key) }} /> {item.label}</label>{/each}
    </fieldset>
    <label>At least this many in service at all times<input inputmode="numeric" bind:value={atLeast} /></label>
  {:else if kind === 'due'}
    <Choice label="Job" bind:value={job} options={[{ value: '', label: 'Choose…' }, ...context.inputs.jobs.map(item => ({ value: item.key, label: item.title }))]} />
    <label>Finished by ({context.format.zone})<input type="datetime-local" bind:value={finishBy} /></label>
    <p class="hint">A due time is a rule: no plan may finish the job later. A wanted finish that may slip is a target on the job instead.</p>
  {:else}
    <Choice label="Function group" bind:value={group} options={[{ value: '', label: 'Choose…' }, ...context.inputs.groups.map(item => ({ value: item.key, label: item.label }))]} />
    <div class="field-pair">
      <label>Out at most<input inputmode="decimal" bind:value={limit} /></label>
      <Choice label="Unit" bind:value={limitUnit} options={[{ value: 'h', label: 'hours' }, { value: 'd', label: 'days' }, { value: 'min', label: 'minutes' }]} />
    </div>
  {/if}
  <Choice label="Who says so" bind:value={sourceBy} options={[{ value: 'planner', label: 'My own rule' }, { value: 'reference', label: 'From a reference (name it below)' }, { value: 'assumption', label: 'Assumption, not yet confirmed' }]} />
  <label>Where it comes from<input bind:value={sourceNote} /></label>
  <button type="submit" disabled={busy}>Preview</button>
  {#if problems.length > 0}<ul class="problems">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
</form>
