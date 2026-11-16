<script lang="ts">
  import { onMount } from 'svelte'
  import { deliveryDemoDefinitionId } from '../definitions/delivery-demo.ts'
  import { combineWorldFacts } from '../plan/schema.ts'
  import { isRequestError, refusalText, type PlanningClient } from './api.ts'
  import { createTimeFormat, quantityText } from './format.ts'
  import { planOptions, type DatedRow, type PlanModel } from './model.ts'
  import { loadPlan, loadRows } from './read-plan.ts'

  let { client, run, mapHref, planHref }: {
    client: PlanningClient
    run: string
    mapHref: (objectId?: string) => string
    planHref: (plan: string) => string
  } = $props()

  let model = $state<PlanModel | null>(null)
  let schedules = $state<Readonly<Record<string, readonly DatedRow[]>>>({})
  let selected = $state<string | null>(null)
  let loading = $state(true)
  let generating = $state(false)
  let error = $state<string | null>(null)
  let pending: AbortController | null = null

  const inputs = $derived(model?.inputs)
  const time = $derived(createTimeFormat(inputs?.settings.timeZone ?? null))
  const truck = $derived(inputs?.resources[0])
  const unloadTime = $derived.by(() => {
    const duration = inputs?.jobs[0]?.duration
    if (duration?.origin.by !== 'world' || inputs === undefined) return null
    const read = combineWorldFacts(duration.origin.refs, inputs.world.facts, duration.unit)
    return read.ok ? quantityText(read.value, read.unit) : null
  })
  const transfer = $derived(inputs?.links[0]?.lag)
  const targets = $derived(new Set(inputs?.jobs.map(job => job.target?.finishBy)))
  const target = $derived(targets.size === 1 ? [...targets][0] : undefined)
  const order = $derived(inputs?.methods.find(method => method.key === 'order'))
  const choices = $derived.by(() => {
    if (model === null || order === undefined) return []
    const feasible = planOptions(model).filter(option => option.fresh && option.status.word === 'validated feasible')
    return order.options.flatMap(choice => {
      const option = feasible.find(item => item.variant.methods.some(method => method.choice === order?.key && method.option === choice.key))
      return option === undefined ? [] : [{ label: choice.label, key: option.key }]
    })
  })
  const rows = $derived(selected === null ? [] : schedules[selected] ?? [])
  const shownRows = $derived([...rows].sort((left, right) => Date.parse(left.start) - Date.parse(right.start)))

  // This guide uses this scenario's Einsatz unit and task locators. World resolves and verifies the target.
  const worldObject = (locator: string | undefined): string | undefined => {
    const path = locator?.match(/^einsatz\/(?:unit|task)\/([^/]+)$/)?.[1]
    if (path === undefined) return undefined
    try { return decodeURIComponent(path) } catch { return undefined }
  }
  const truckObject = $derived(worldObject(truck?.locator))
  const targetResult = (finish: string, finishBy: string): string => {
    const late = (Date.parse(finish) - Date.parse(finishBy)) / 60_000
    return late <= 0 ? 'On time' : `${quantityText(late, 'min')} late`
  }

  const read = async (id: string) => {
    const next = await loadPlan(client, id)
    const entries = await Promise.all(planOptions(next)
      .filter(option => option.fresh && option.status.word === 'validated feasible')
      .map(async option => [option.key, next.rows[option.key] ?? await loadRows(client, id, option.key)] as const))
    schedules = Object.fromEntries(entries)
    const recommended = entries.find(([key]) => key === next.options?.recommended)
    selected = recommended?.[0] ?? entries[0]?.[0] ?? null
    model = next
  }

  const prepare = async () => {
    loading = true
    error = null
    const controller = new AbortController()
    pending = controller
    try {
      const catalog = await client.definitions()
      const definition = catalog.definitions.find(item => item.ref.id === deliveryDemoDefinitionId)
      if (definition === undefined) throw new Error('The delivery plan is unavailable. Try opening it again.')
      const answer = await client.createDemo(definition, run, controller.signal)
      await read(answer.result.plan.id)
    } catch (cause) {
      if (!controller.signal.aborted) error = refusalText(cause)
    } finally {
      pending = null
      loading = false
    }
  }

  const generate = async () => {
    if (model === null || generating) return
    generating = true
    error = null
    const controller = new AbortController()
    pending = controller
    try {
      const current = model
      const result = await client.generate(current.id, current.revision, { seconds: 5 }, controller.signal)
      await read(current.id)
      if (!result.options.some(option => option.status.word === 'validated feasible')) {
        error = 'Planning could not find a schedule. Try again, or open the full plan to see the details.'
      }
    } catch (cause) {
      if (controller.signal.aborted) return
      if (isRequestError(cause) && cause.code === 'plan_revision_conflict') {
        try { await read(model.id) } catch (readCause) { error = refusalText(readCause); return }
        error = 'This plan was changed. The latest version is open. Generate schedules again to use it.'
      } else {
        error = refusalText(cause)
      }
    } finally {
      pending = null
      generating = false
    }
  }

  onMount(() => {
    void prepare()
    return () => pending?.abort()
  })
</script>

<main class="delivery">
  <header>
    <a href={mapHref()} target="_top">← Back to World map</a>
    <h1>Plan two deliveries</h1>
    <p>The school and the sports hall need deliveries. One truck serves both. Compare what happens when you change which stop comes first.</p>
  </header>

  {#if loading}
    <p role="status">Reading the delivery truck from this World run…</p>
  {/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
    {#if model === null && !loading}<button type="button" onclick={() => void prepare()}>Try again</button>{/if}
  {/if}

  {#if model}
    <dl class="inputs">
      <div>
        <dt>From World</dt>
        <dd>
          {#if unloadTime}{unloadTime} to unload at each stop, from the {truck?.label.toLowerCase() ?? 'truck'} in this run.{:else}Truck unloading time unavailable.{/if}
          {#if truckObject}<a href={mapHref(truckObject)} target="_top">Show truck on map</a>{/if}
        </dd>
      </div>
      <div>
        <dt>In the plan</dt>
        <dd>
          {#if transfer && target}
            Allow {quantityText(transfer.value, transfer.unit)} between stops. Both want unloading finished by {time.time(target)}.
          {:else}
            The plan sets the time between stops and delivery targets.
          {/if}
        </dd>
      </div>
    </dl>

    <section class="schedule" aria-labelledby="schedule-heading">
      <div class="schedule-head">
        <div>
          <h2 id="schedule-heading">Delivery schedule</h2>
          {#if choices.length === 0}
            <p>Generate schedules to see when the truck can unload at each stop.</p>
          {:else}
            <p>Switch the order and see which stop meets its target.</p>
          {/if}
        </div>
        {#if choices.length < (order?.options.length ?? 2)}
          <button type="button" class="primary" disabled={generating || unloadTime === null} onclick={() => void generate()}>{generating ? 'Generating…' : 'Generate schedules'}</button>
        {/if}
      </div>
      {#if generating}
        <p class="hint" role="status">Planning is checking the schedules.</p>
      {/if}
      {#if choices.length > 0}
        <div class="choices" role="group" aria-label="Delivery order">
          {#each choices as choice (choice.key)}
            <button type="button" aria-pressed={selected === choice.key} onclick={() => { selected = choice.key }}>{choice.label}</button>
          {/each}
        </div>
        <ul class="stops" aria-live="polite">
          {#each shownRows as row (row.job)}
            {@const job = inputs?.jobs.find(item => item.key === row.job)}
            {@const finishBy = job?.target?.finishBy}
            {@const objectId = worldObject(job?.locator)}
            <li class="stop">
              <span class="stop-time"><time datetime={row.start}>{time.time(row.start)}</time>–<time datetime={row.finish}>{time.time(row.finish)}</time></span>
              <strong>{job?.title ?? row.job}</strong>
              {#if finishBy}<span class:late={Date.parse(row.finish) > Date.parse(finishBy)} class="arrival">{targetResult(row.finish, finishBy)}</span>{/if}
              {#if objectId}<a href={mapHref(objectId)} target="_top" aria-label={`Show ${job?.title ?? 'delivery'} on map`}>Show on map</a>{/if}
            </li>
          {/each}
        </ul>
        <p class="hint">These are schedules to compare. The truck stays where it is in World until a dispatch order is given there.</p>
      {/if}
    </section>

    <a class="full-plan" href={planHref(model.id)} target="_top">Open full plan</a>
  {/if}
</main>

<style>
  .delivery { max-width: 800px; margin: 0 auto; padding: clamp(20px, 4vw, 48px) 16px; }
  a { color: var(--accent); font-weight: 600; text-underline-offset: 3px; }
  header { margin-bottom: 24px; }
  header h1 { margin: 12px 0 7px; font-size: clamp(25px, 4vw, 36px); }
  header p { max-width: 55ch; font-size: 16px; color: var(--ink-2); }
  .inputs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: 12px; margin: 0 0 20px; }
  .inputs div, .schedule { background: var(--card); border: 1px solid var(--line); border-radius: 9px; padding: 16px; }
  .inputs div:first-child { background: var(--world-bg); }
  dt { font-weight: 650; margin-bottom: 4px; }
  dd { margin: 0; }
  dd a { display: block; margin-top: 4px; }
  .schedule-head { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: flex-start; }
  .schedule h2 { margin: 0 0 4px; font-size: 18px; }
  .schedule p { margin-bottom: 0; color: var(--ink-2); }
  .choices { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
  .choices button[aria-pressed='true'] { background: var(--accent-2); border-color: var(--accent); font-weight: 650; }
  .stops { list-style: none; padding: 0; margin: 14px 0 10px; border-top: 1px solid var(--line); }
  .stop { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px 12px; padding: 9px 0; border-bottom: 1px solid var(--line); }
  .stop-time { font-variant-numeric: tabular-nums; }
  .stop strong { flex: 1; min-width: 110px; }
  .arrival { font-size: 12px; background: var(--good-bg); color: var(--good); padding: 1px 6px; border-radius: 4px; }
  .arrival.late { background: var(--warning-bg); color: var(--warning); }
  .full-plan { display: inline-block; margin-top: 16px; }
</style>
