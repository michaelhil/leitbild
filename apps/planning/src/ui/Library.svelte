<script lang="ts">
  import { onMount } from 'svelte'
  import type { ModuleDefinitionDescriptor, ModuleResourceDescriptor } from '@leitbild/contracts'
  import { PLAN, refusalText, type PlanningClient } from './api.ts'
  import { blankDefinitionId, createLibraryActions, declaresRoles, definitionsForRun, plansBesideRun, rolesOffer, runOfferText, runResourceOf, startsHere, windowBesideRun, type RunOffer } from './beside-run.ts'
  import { localInputValue, planEdits, type PlanForm } from './edit-forms.ts'
  import { changedText } from './format.ts'
  import NewPlanForm from './NewPlanForm.svelte'

  // The plans and templates in this Workspace. A guided plan starts from its World demo, not from here.
  // Beside a Run (`run`): the plans for that Run, a new plan for it, and the plans linked to no Run.
  let { client, onOpen, run = null, initialDefinitions = [], initialResources = [], initialOffer = { state: 'reading' } }: {
    client: PlanningClient
    onOpen: (plan: string) => void
    run?: string | null
    initialDefinitions?: readonly ModuleDefinitionDescriptor[]
    initialResources?: readonly ModuleResourceDescriptor[]
    initialOffer?: RunOffer
  } = $props()

  // The initial props seed the page once (a test renders a listing it already has); the reads replace them.
  // svelte-ignore state_referenced_locally
  let resources = $state<readonly ModuleResourceDescriptor[]>(initialResources)
  // svelte-ignore state_referenced_locally
  let definitions = $state<readonly ModuleDefinitionDescriptor[]>(initialDefinitions)
  // svelte-ignore state_referenced_locally
  let offer = $state<RunOffer>(initialOffer)
  // svelte-ignore state_referenced_locally
  let loading = $state(initialDefinitions.length === 0)
  let busy = $state(false)
  let progress = $state<string | null>(null)
  let error = $state<string | null>(null)
  let creating = $state(false)

  const actions = $derived(createLibraryActions(client, text => { progress = text }))
  const plans = $derived(resources.filter(resource => resource.ref.type === PLAN))
  const besideRun = $derived(run === null ? null : runResourceOf(resources, run))
  const grouped = $derived(run === null ? null : plansBesideRun(resources, run))
  // Beside a Run only the Definitions it allows; otherwise every Definition, the blank one first.
  const shown = $derived(run === null ? definitions : besideRun === null ? [] : definitionsForRun(definitions, besideRun))
  const blank = $derived(shown.find(definition => definition.ref.id === blankDefinitionId))
  const demos = $derived(shown.filter(definition => definition.ref.id !== blankDefinitionId))
  const worldDemoHref = (definition: ModuleDefinitionDescriptor): string => `/workspaces?${new URLSearchParams({ demos: `world:${definition.ref.id}` })}`
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  // Beside a Run whose values carry a simulation time, a new plan's window starts there; otherwise tomorrow at 07:00.
  const runWindow = $derived(offer.state === 'read' && offer.simulationAt !== null ? windowBesideRun(offer.simulationAt) : null)
  const startDefault = (): string => {
    if (runWindow !== null) return localInputValue(runWindow.start, zone)
    const tomorrow = new Date(Date.now() + 86_400_000)
    tomorrow.setHours(7, 0, 0, 0)
    return localInputValue(tomorrow.toISOString(), zone)
  }
  const endDefault = (): string => {
    if (runWindow !== null) return localInputValue(runWindow.end, zone)
    const later = new Date(Date.now() + 6 * 86_400_000)
    later.setHours(7, 0, 0, 0)
    return localInputValue(later.toISOString(), zone)
  }

  onMount(() => {
    void (async () => {
      try {
        const [catalog, listing] = await Promise.all([client.catalog(), client.definitions()])
        resources = catalog.resources
        definitions = listing.definitions
      } catch (cause) { error = refusalText(cause) } finally { loading = false }
      // What this Run offers is read once, after the catalogue: World reads no planning values from a Run with
      // roles, whoever asks, so such a Run is not asked.
      const described = run === null ? null : runResourceOf(resources, run)
      if (run !== null && described !== null) offer = declaresRoles(described) ? rolesOffer : await actions.runOffer(run)
    })()
  })

  const attempt = (work: () => Promise<string>) => {
    busy = true
    error = null
    void (async () => {
      try { onOpen(await work()) } catch (cause) { error = refusalText(cause) } finally { busy = false; progress = null }
    })()
  }
  const start = (definition: ModuleDefinitionDescriptor) => attempt(() => actions.start(definition, run))
  const openGuided = (definition: ModuleDefinitionDescriptor, forRun: string) => attempt(() => actions.openGuided(definition, forRun))
  const createBlank = (form: PlanForm) => {
    if (blank === undefined) return
    // Goals are counted in the plan's own currency, which the Workspace sets at create: they follow it.
    const first = planEdits(form)
    if (!first.ok) { error = first.problems.join(' '); return }
    const definition = blank
    attempt(() => actions.startBlank(definition, form, run))
  }
  const updated = (resource: ModuleResourceDescriptor) => {
    const item = resource.summary.find(entry => entry.key === 'updated-at')
    return item?.kind === 'timestamp' ? changedText(item.value, Date.now(), zone) : null
  }
</script>

{#snippet planItem(plan: ModuleResourceDescriptor)}
  <li><button type="button" class="link" onclick={() => onOpen(plan.ref.id)}><strong>{plan.title}</strong>{#if updated(plan)}<span class="hint">{` · ${updated(plan)}`}</span>{/if}</button></li>
{/snippet}

{#snippet choices()}
  {#if creating}
    <NewPlanForm {busy} forRun={run !== null} defaultZone={zone} defaultStart={startDefault()} defaultEnd={endDefault()} onCreate={createBlank} onCancel={() => { creating = false }} />
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
          {#if run !== null}
            {@const forRun = run}
            {#if startsHere(definition)}
              <button type="button" disabled={busy} onclick={() => start(definition)}>Start this plan for this Run</button>
            {:else}
              <button type="button" disabled={busy} onclick={() => openGuided(definition, forRun)}>Open this Run's plan</button>
            {/if}
          {:else if startsHere(definition)}
            <button type="button" disabled={busy} onclick={() => start(definition)}>Start this plan</button>
          {:else}
            <a class="world-demo-link" href={worldDemoHref(definition)} target="_top">Open World demo</a>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
{/snippet}

<main class="library">
  <p class="eyebrow">Planning</p>
  {#if run === null}
    <h1>Plan work against real equipment</h1>
    <p class="intro">List the work, the crews and their shifts, and the rules that must hold. Generate says when each job can run, why, and how sure it is.</p>
  {:else}
    <h1>{besideRun === null ? 'Plans for this Run' : `Plans for “${besideRun.title}”`}</h1>
    <p class="intro">A plan for this Run reads its values from this simulation. The simulation keeps running while you plan.</p>
  {/if}
  <p class="hint release-note">Release 2 of 3: compare options, see what overtime buys, ask what-ifs and see why one is recommended. Recording progress and replanning after disruptions come in release 3.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if progress}<p class="notice" aria-live="polite">{progress}</p>{/if}
  {#if loading}
    <p class="loading">Loading plans…</p>
  {:else if run === null || grouped === null}
    {@render choices()}
    <h2>Plans in this Workspace</h2>
    {#if plans.length === 0}<p class="hint">No plans yet.</p>{/if}
    <ul class="plan-list">
      {#each plans as plan (plan.ref.id)}{@render planItem(plan)}{/each}
    </ul>
  {:else}
    <section class="beside-group" aria-labelledby="for-run-title">
      <h2 id="for-run-title">Plans for this Run</h2>
      {#if grouped.forRun.length === 0}<p class="hint">No plan is linked to this Run yet.</p>{/if}
      <ul class="plan-list">
        {#each grouped.forRun as plan (plan.ref.id)}{@render planItem(plan)}{/each}
      </ul>
    </section>
    <section class="beside-group" aria-labelledby="new-for-run-title">
      <h2 id="new-for-run-title">New plan for this Run</h2>
      <p class="hint run-offer" aria-live="polite">{runOfferText(offer)}</p>
      {#if besideRun === null}
        <p class="error" role="alert">Planning cannot find this Run in the Workspace, so it cannot start a plan for it. Open the Run again from the Workspace page.</p>
      {:else}
        {@render choices()}
      {/if}
    </section>
    {#if grouped.unlinked.length > 0}
      <details class="beside-group unlinked">
        <summary>Unlinked plans ({grouped.unlinked.length})</summary>
        <p class="hint">These plans are linked to no Run. Open one to link it to this Run.</p>
        <ul class="plan-list">
          {#each grouped.unlinked as plan (plan.ref.id)}{@render planItem(plan)}{/each}
        </ul>
      </details>
    {/if}
  {/if}
</main>

<style>
  .world-demo-link { color: var(--accent); font-weight: 600; text-underline-offset: 3px; }
  .beside-group { margin: 20px 0 8px; }
  .beside-group .demo-grid { margin-top: 12px; }
  .unlinked summary { cursor: pointer; font-weight: 600; }
</style>
