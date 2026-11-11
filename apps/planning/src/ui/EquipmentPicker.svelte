<script lang="ts">
  import type { PlanningSubject } from '@leitbild/contracts'
  import type { Edit } from '../plan/edit-schema.ts'
  import { equipmentFromWorld, resourceFromWorld } from './edit-forms.ts'
  import { factText } from './format.ts'
  import MarkTag from './MarkTag.svelte'
  import type { RunChoice } from './model.ts'
  import type { Context } from './status-text.ts'

  // Link a simulation the person started in World, find items in it by name, and add them as equipment
  // or as crews and tools. Planning only reads World; every value shows its basis and read time.
  let { context, runs, linkedRun, busy = false, onLink, onRefresh, onOpenWorkspace, onFindRuns, onSearch, onDetail, onPreview }: {
    context: Context
    runs: readonly RunChoice[]
    linkedRun: string | null
    busy?: boolean
    onLink: (run: string) => void
    onRefresh: () => void
    onOpenWorkspace: () => void
    onFindRuns: () => void
    onSearch: (text: string) => Promise<readonly PlanningSubject[]>
    onDetail: (locator: string) => Promise<PlanningSubject>
    onPreview: (edits: readonly Edit[], label: string) => void
  } = $props()

  const settings = $derived(context.inputs.settings)
  const scenario = $derived(settings.scenario)
  let chosenRun = $state('')
  let text = $state('')
  let results = $state<readonly PlanningSubject[] | null>(null)
  let searching = $state(false)
  let group = $state('')
  let newGroup = $state('')
  let calendar = $state('')
  let kind = $state<'crew' | 'tool'>('tool')
  let problems = $state<readonly string[]>([])

  const factsOf = (locator: string | undefined) => locator === undefined ? [] : context.inputs.world.facts.filter(fact => fact.locator === locator)
  const search = async (event: SubmitEvent) => {
    event.preventDefault()
    if (text.trim() === '') return
    searching = true
    problems = []
    try { results = await onSearch(text.trim()) } catch (error) { problems = [error instanceof Error ? error.message : 'World did not answer.'] } finally { searching = false }
  }
  const add = async (subject: PlanningSubject, as: 'equipment' | 'resource') => {
    problems = []
    try {
      const detail = await onDetail(subject.locator)
      const built = as === 'equipment' ? equipmentFromWorld(detail, { group, newGroup }, context.inputs) : resourceFromWorld(detail, { kind, calendar }, context.inputs)
      if (!built.ok) { problems = built.problems; return }
      onPreview(built.edits, as === 'equipment' ? `Add ${subject.label} as equipment` : `Add ${subject.label} as a ${kind === 'crew' ? 'crew' : 'tool'}`)
    } catch (error) { problems = [error instanceof Error ? error.message : 'World did not answer.'] }
  }
  const matching = $derived(runs.filter(run => run.matches))
  const others = $derived(runs.filter(run => !run.matches))
</script>

<section class="picker" aria-labelledby="picker-title">
  <h2 id="picker-title">Equipment and World</h2>
  {#if settings.run === null}
    <p>Planning reads values from a simulation you start in World. It never starts, pauses or changes one.</p>
    {#if matching.length === 0 && scenario !== undefined}<p class="hint">No “{scenario.title}” simulation is running yet. Start it from its card on the Workspace page, then come back.</p>{/if}
    <div class="actions">
      <button type="button" onclick={onOpenWorkspace}>Open the Workspace</button>
      <button type="button" disabled={busy} onclick={onFindRuns}>Look for running simulations again</button>
    </div>
    {#if runs.length === 0}<p class="hint">No simulation is running in this Workspace yet.</p>{/if}
    {#if runs.length > 0}
      <form class="mini-form" onsubmit={(event) => { event.preventDefault(); if (chosenRun !== '') onLink(chosenRun) }}>
        <fieldset>
          <legend>Link the running simulation</legend>
          {#each matching as run (run.id)}<label class="inline"><input type="radio" bind:group={chosenRun} value={run.id} /> {run.title} <small>{run.status}</small></label>{/each}
          {#if others.length > 0}
            {#if scenario !== undefined}<p class="hint">Other simulations in this Workspace:</p>{/if}
            {#each others as run (run.id)}<label class="inline"><input type="radio" bind:group={chosenRun} value={run.id} /> {run.title} <small>{run.status}</small></label>{/each}
          {/if}
        </fieldset>
        <button type="submit" class="primary" disabled={busy || chosenRun === ''}>Link and read its values</button>
      </form>
    {/if}
  {:else}
    <p><MarkTag mark={{ shape: '◉', word: 'Linked' }} tone="world" /> {linkedRun ?? 'A simulation in this Workspace'}.
      {context.inputs.world.refreshedAt === null ? 'Its values are not read yet.' : `Values read ${context.format.clock(context.inputs.world.refreshedAt)}.`}</p>
    <button type="button" disabled={busy} onclick={onRefresh}>Read the World values again</button>
  {/if}

  <h3>Equipment in this plan</h3>
  {#if context.inputs.equipment.length === 0}<p class="hint">None yet.</p>{/if}
  <ul class="item-list">
    {#each context.inputs.equipment as item (item.key)}
      <li>
        <strong>{item.label}</strong>
        {#if item.group}<small>{context.names.group(item.group)}</small>{/if}
        {#if item.supportedBy.length > 0}<small>Unavailable while {context.names.list(item.supportedBy, context.names.equipment)} is out</small>{/if}
        {#if item.locator === undefined}<small><MarkTag mark={{ shape: '●', word: 'Planner' }} /> Not a World item</small>
        {:else if factsOf(item.locator).length === 0}<small><MarkTag mark={{ shape: '?', word: 'Unknown' }} tone="unknown" /> Not read from World yet</small>
        {:else}
          {#each factsOf(item.locator) as fact (fact.id)}<small><MarkTag mark={{ shape: '◉', word: 'World' }} tone="world" /> {factText(fact, context.format)}</small>{/each}
        {/if}
      </li>
    {/each}
  </ul>

  {#if settings.run !== null}
    <form class="mini-form" onsubmit={search}>
      <h3>Find in World</h3>
      <label>Name<input bind:value={text} placeholder="e.g. pump" /></label>
      <button type="submit" disabled={busy || searching}>{searching ? 'Searching…' : 'Search'}</button>
    </form>
    {#if results !== null}
      {#if results.length === 0}<p class="hint">Nothing in World matches “{text}”.</p>{/if}
      <div class="field-pair">
        <label>Function group for new equipment
          <select bind:value={group}><option value="">None</option>{#each context.inputs.groups as item (item.key)}<option value={item.key}>{item.label}</option>{/each}</select>
        </label>
        <label>Or a new group<input bind:value={newGroup} /></label>
      </div>
      <div class="field-pair">
        <label>New crew or tool is a
          <select bind:value={kind}><option value="tool">tool or vehicle</option><option value="crew">crew</option></select>
        </label>
        <label>Available on
          <select bind:value={calendar}><option value="">the whole window</option>{#each context.inputs.calendars as item (item.key)}<option value={item.key}>{item.label}</option>{/each}</select>
        </label>
      </div>
      <ul class="item-list">
        {#each results as subject (subject.locator)}
          <li>
            <strong>{subject.label}</strong> <small>{subject.kind}</small>
            {#each subject.facts.slice(0, 4) as fact (fact.id)}<small><MarkTag mark={{ shape: '◉', word: 'World' }} tone="world" /> {factText(fact, context.format)}</small>{/each}
            <span class="actions">
              <button type="button" disabled={busy} onclick={() => add(subject, 'equipment')}>Add as equipment</button>
              <button type="button" disabled={busy} onclick={() => add(subject, 'resource')}>Add as crew or tool</button>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
  {#if problems.length > 0}<ul class="problems">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
</section>
