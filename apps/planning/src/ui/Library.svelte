<script lang="ts">
  import { onMount } from 'svelte'
  import type { ModuleDefinitionDescriptor, ModuleResourceDescriptor } from '@leitbild/contracts'
  import { PLAN, refusalText, type PlanningClient } from './api.ts'
  import { goalsEdit, localInputValue, planEdits, type PlanForm } from './edit-forms.ts'
  import { changedText } from './format.ts'
  import NewPlanForm from './NewPlanForm.svelte'
  import { summaryDataSchema } from '../api/contract.ts'

  // The plans and templates in this Workspace. A guided plan starts from its World demo, not from here.
  let { client, onOpen, initialDefinitions = [] }: {
    client: PlanningClient
    onOpen: (plan: string) => void
    initialDefinitions?: readonly ModuleDefinitionDescriptor[]
  } = $props()

  let plans = $state<readonly ModuleResourceDescriptor[]>([])
  // The initial Definitions seed the cards once (a test renders a listing it already has); the read replaces them.
  // svelte-ignore state_referenced_locally
  let definitions = $state<readonly ModuleDefinitionDescriptor[]>(initialDefinitions)
  // svelte-ignore state_referenced_locally
  let loading = $state(initialDefinitions.length === 0)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let creating = $state(false)

  const blank = $derived(definitions.find(definition => definition.ref.id === 'blank'))
  const demos = $derived(definitions.filter(definition => definition.ref.id !== 'blank'))
  // Planning publishes a primary action only for a Definition that planning.plan.create starts on its own.
  // A guided plan has none: it opens from its World demo, which has the same Definition id.
  const startsHere = (definition: ModuleDefinitionDescriptor): boolean => definition.primaryCapabilityId !== undefined
  const worldDemoHref = (definition: ModuleDefinitionDescriptor): string => `/workspaces?${new URLSearchParams({ demos: `world:${definition.ref.id}` })}`
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const startDefault = (): string => {
    const tomorrow = new Date(Date.now() + 86_400_000)
    tomorrow.setHours(7, 0, 0, 0)
    return localInputValue(tomorrow.toISOString(), zone)
  }
  const endDefault = (): string => {
    const later = new Date(Date.now() + 6 * 86_400_000)
    later.setHours(7, 0, 0, 0)
    return localInputValue(later.toISOString(), zone)
  }

  onMount(() => {
    void (async () => {
      try {
        const [catalog, listing] = await Promise.all([client.catalog(), client.definitions()])
        plans = catalog.resources.filter(resource => resource.ref.type === PLAN)
        definitions = listing.definitions
      } catch (cause) { error = refusalText(cause) } finally { loading = false }
    })()
  })

  const start = (definition: ModuleDefinitionDescriptor) => {
    busy = true
    error = null
    void (async () => {
      try {
        const created = await client.create(definition)
        onOpen(created.result.plan.id)
      } catch (cause) { error = refusalText(cause) } finally { busy = false }
    })()
  }
  const createBlank = (form: PlanForm) => {
    if (blank === undefined) return
    // Goals are counted in the plan's own currency, which the Workspace sets at create: they follow it.
    const first = planEdits(form)
    if (!first.ok) { error = first.problems.join(' '); return }
    const definition = blank
    busy = true
    error = null
    void (async () => {
      try {
        const created = await client.create(definition, [first.edits[0]!], form.grid)
        const plan = created.result.plan
        const summary = summaryDataSchema.parse((await client.read(plan.id, { section: 'summary' })).sections.find(section => section.id === 'summary')?.data)
        const goals = goalsEdit(form.goals, summary.settings.currency)
        if (!goals.ok) throw new Error(goals.problems.join(' '))
        await client.edit(plan.id, plan.revision, { edits: [...goals.edits] })
        onOpen(plan.id)
      } catch (cause) { error = refusalText(cause) } finally { busy = false }
    })()
  }
  const updated = (resource: ModuleResourceDescriptor) => {
    const item = resource.summary.find(entry => entry.key === 'updated-at')
    return item?.kind === 'timestamp' ? changedText(item.value, Date.now(), zone) : null
  }
</script>

<main class="library">
  <p class="eyebrow">Planning</p>
  <h1>Plan work against real equipment</h1>
  <p class="intro">List the work, the crews and their shifts, and the rules that must hold. Generate says when each job can run, why, and how sure it is.</p>
  <p class="hint release-note">Release 2 of 3: compare options, see what overtime buys, ask what-ifs and see why one is recommended. Recording progress and replanning after disruptions come in release 3.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if loading}
    <p class="loading">Loading plans…</p>
  {:else}
    {#if creating}
      <NewPlanForm {busy} defaultZone={zone} defaultStart={startDefault()} defaultEnd={endDefault()} onCreate={createBlank} onCancel={() => { creating = false }} />
    {:else}
      <div class="demo-grid">
        {#if blank}
          <article class="demo-card">
            <h2>{blank.title}</h2>
            <p>{blank.description ?? 'Start from empty: name, window, time zone and goals.'}</p>
            <button type="button" class="primary" disabled={busy} onclick={() => { creating = true }}>New plan</button>
          </article>
        {/if}
        {#each demos as definition (definition.ref.id)}
          <article class="demo-card">
            <h2>{definition.title}</h2>
            {#if definition.description}<p>{definition.description}</p>{/if}
            {#if startsHere(definition)}
              <button type="button" disabled={busy} onclick={() => start(definition)}>Start this plan</button>
            {:else}
              <a class="world-demo-link" href={worldDemoHref(definition)} target="_top">Open World demo</a>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
    <h2>Plans in this Workspace</h2>
    {#if plans.length === 0}<p class="hint">No plans yet.</p>{/if}
    <ul class="plan-list">
      {#each plans as plan (plan.ref.id)}
        <li><button type="button" class="link" onclick={() => onOpen(plan.ref.id)}><strong>{plan.title}</strong>{#if updated(plan)}<span class="hint">{` · ${updated(plan)}`}</span>{/if}</button></li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  .world-demo-link { color: var(--accent); font-weight: 600; text-underline-offset: 3px; }
</style>
