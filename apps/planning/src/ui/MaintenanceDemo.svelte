<script lang="ts">
  import { onMount } from 'svelte'
  import type { WorkspaceResourceReference } from '@leitbild/contracts'
  import { refusalText, type PlanningClient } from './api.ts'
  import { createTimeFormat, moneyText, quantityText, spanText } from './format.ts'
  import { planOptions, type DatedRow, type OptionView, type PlanModel } from './model.ts'
  import { loadPlan, loadRows } from './read-plan.ts'
  import { extraMaintenanceCrew, maintenanceCost, maintenanceDefinitionId, maintenanceFinish, maintenancePlantId, maintenancePrompt, maintenanceVariants } from './maintenance-demo.ts'

  let { client, run, initialOption = null, worldHref, planHref, onAgent }: {
    client: PlanningClient
    run: string
    initialOption?: string | null
    worldHref: (objectId: string, elementId?: string, option?: string) => string
    planHref: (plan: string) => string
    onAgent: (room: WorkspaceResourceReference, option: string) => void
  } = $props()

  let model = $state<PlanModel | null>(null)
  let schedules = $state<Readonly<Record<string, readonly DatedRow[]>>>({})
  let selectedKey = $state<string | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)
  let asking = $state(false)
  let agentError = $state<string | null>(null)
  let controller: AbortController | null = null

  const time = $derived(createTimeFormat(model?.inputs.settings.timeZone ?? null))
  const options = $derived(model === null ? [] : planOptions(model))
  const selected = $derived(options.find(option => option.key === selectedKey))
  const rows = $derived(selectedKey === null ? [] : schedules[selectedKey] ?? [])
  const finish = $derived(maintenanceFinish(rows))
  const window = $derived(model?.inputs.settings.window)
  const start = $derived(window === null || window === undefined ? 0 : Date.parse(window.start))
  const end = $derived(window === null || window === undefined ? 0 : Date.parse(window.end))
  const target = $derived(model?.inputs.jobs.find(job => job.key === 'restore')?.target?.finishBy)
  const targetTime = $derived(target === undefined ? null : Date.parse(target))
  const oneCrew = $derived(options.find(option => !option.variant.purchases.includes(extraMaintenanceCrew)))
  const extraCrew = $derived(options.find(option => option.variant.purchases.includes(extraMaintenanceCrew)))
  const baselineFinish = $derived(oneCrew === undefined ? null : maintenanceFinish(schedules[oneCrew.key] ?? []))
  const extraFinish = $derived(extraCrew === undefined ? null : maintenanceFinish(schedules[extraCrew.key] ?? []))
  const savedTime = $derived(baselineFinish === null || extraFinish === null ? null : baselineFinish - extraFinish)
  const backup = $derived(model?.inputs.world.facts.find(fact => fact.id === `${maintenancePlantId}/componentCoolingWaterPumpB/runningState`))
  const flow = $derived(model?.inputs.world.facts.find(fact => fact.id === `${maintenancePlantId}/componentCoolingWaterPumpB/flowKgPerS`))
  const extraBooking = $derived(model?.inputs.purchases.find(purchase => purchase.key === extraMaintenanceCrew)?.price.once)
  const ticks = $derived(model === null ? [] : Array.from({ length: 7 }, (_, index) => start + (end - start) * index / 6))
  const prompt = $derived(model !== null && selected !== undefined ? maintenancePrompt(model, selected) : '')
  const percent = (instant: number): number => end <= start ? 0 : (instant - start) / (end - start) * 100
  const optionFinish = (option: OptionView): number | null => maintenanceFinish(schedules[option.key] ?? [])
  const rowFor = (job: string): DatedRow | undefined => rows.find(row => row.job === job)
  const plantHref = (elementId?: string): string => worldHref(maintenancePlantId, elementId, selectedKey ?? undefined)
  const mapElement = (job: string): string | undefined => job === 'pump-work' ? 'componentCoolingWaterPumpA'
    : job === 'hx-work' ? 'componentCoolingHeatExchangerA' : undefined

  const read = async (plan: string): Promise<PlanModel> => {
    const next = await loadPlan(client, plan)
    if (next.inputs.settings.window === null || next.inputs.jobs.find(job => job.key === 'restore')?.target === undefined) {
      throw new Error('This demonstration needs a work window and a return-to-service target. Open the full plan to inspect the changes.')
    }
    const dated = await Promise.all(planOptions(next).filter(option => option.fresh && option.status.word === 'validated feasible')
      .map(async option => [option.key, next.rows[option.key] ?? await loadRows(client, plan, option.key)] as const))
    schedules = Object.fromEntries(dated)
    const previous = dated.find(([key]) => key === (selectedKey ?? initialOption))
    const baseline = planOptions(next).find(option => option.fresh && option.status.word === 'validated feasible' && !option.variant.purchases.includes(extraMaintenanceCrew))
    selectedKey = previous?.[0] ?? baseline?.key ?? dated[0]?.[0] ?? null
    model = next
    return next
  }

  const prepare = async (): Promise<void> => {
    if (controller !== null) return
    loading = true
    error = null
    const pending = new AbortController()
    controller = pending
    try {
      const definitions = await client.definitions()
      const definition = definitions.definitions.find(item => item.ref.id === maintenanceDefinitionId)
      if (definition === undefined) throw new Error('The maintenance demonstration is unavailable in this Workspace.')
      const answer = await client.createDemo(definition, run, pending.signal)
      const current = await read(answer.result.plan.id)
      if (current.options === null || !planOptions(current).some(option => option.fresh)) {
        await client.generate(current.id, current.revision, maintenanceVariants, pending.signal)
        await read(current.id)
      }
      if (pending.signal.aborted) return
      const shown = model
      if (shown === null || !planOptions(shown).some(option => option.fresh && option.status.word === 'validated feasible')) {
        throw new Error('No checked schedule is available. Open the full plan to inspect its inputs, or try calculating the comparison again.')
      }
    } catch (cause) {
      if (!pending.signal.aborted) error = refusalText(cause)
    } finally {
      controller = null
      loading = false
    }
  }

  const recalculate = async (): Promise<void> => {
    if (model === null || controller !== null) return
    const pending = new AbortController()
    controller = pending
    loading = true
    error = null
    try {
      const current = await read(model.id)
      await client.generate(current.id, current.revision, maintenanceVariants, pending.signal)
      await read(current.id)
    } catch (cause) {
      if (!pending.signal.aborted) error = refusalText(cause)
    } finally {
      controller = null
      loading = false
    }
  }

  const ask = async (): Promise<void> => {
    if (model === null || selected === undefined || asking) return
    asking = true
    agentError = null
    try {
      const room = await client.askEngineering(model.id, run, prompt)
      onAgent(room, selected.key)
    } catch (cause) {
      agentError = refusalText(cause)
    } finally {
      asking = false
    }
  }

  onMount(() => {
    void prepare()
    return () => controller?.abort()
  })
</script>

<main class="maintenance">
  <header>
    <a href={plantHref()} target="_top">← World plant</a>
    <p class="eyebrow">Planning and scheduling · fictional nuclear plant</p>
    <h1>Nuclear maintenance planning</h1>
    <p class="question">{targetTime === null ? 'Can maintenance finish within the shift?' : `Can maintenance finish by ${time.time(targetTime)}?`}</p>
    <p class="brief">Inspect the component cooling water pump and heat exchanger on Train A. Compare one crew with an extra crew working on the separate equipment.</p>
  </header>

  {#if loading}<p class="progress" role="status">{model === null ? 'Reading the plant and preparing the work plan…' : 'Calculating and checking both crew schedules…'}</p>{/if}
  {#if error}
    <div class="error" role="alert"><p>{error}</p><button type="button" disabled={loading} onclick={() => void (model === null ? prepare() : recalculate())}>Try again</button></div>
  {/if}

  {#if model && !loading}
    <p class="plant-state">World reports Pump B {backup?.value === true ? 'running' : backup?.value === false ? 'stopped' : 'with running state unavailable'}{flow !== undefined && typeof flow.value === 'number' ? ` at ${quantityText(flow.value, flow.unit ?? 'kg/s')}` : ''}. <a href={plantHref('componentCoolingWaterPumpB')} target="_top">Inspect in World</a></p>
    <section aria-label="Compare crew schedules" class="comparison">
      {#each options as option (option.key)}
        {@const done = optionFinish(option)}
        {@const cost = maintenanceCost(model, option)}
        <button type="button" class="crew-option" aria-pressed={selectedKey === option.key} onclick={() => { selectedKey = option.key }} disabled={done === null || !option.fresh}>
          <span class="option-title">{option.label}</span>
          {#if done !== null}
            <span class="finish-time">Finish {time.time(done)}</span>
            <span class="target-result" class:late={targetTime !== null && done > targetTime}>
              {#if targetTime !== null}{spanText(Math.abs(done - targetTime))} {done > targetTime ? 'past target' : 'before target'}{/if}
            </span>
          {:else}<span>{option.status.word}</span>{/if}
          <span class="cost">{cost === null ? 'Cost unavailable' : cost === 0 ? 'Existing crew · no extra booking' : `+ ${moneyText(cost, model.inputs.settings.currency)}`}</span>
        </button>
      {/each}
    </section>

    {#if selected && finish !== null}
      <section class="gantt" aria-label="Maintenance schedule">
        <div class="schedule-head">
          <h2 id="maintenance-schedule-title">{selected.label} schedule</h2>
          <span>{time.day(start)} · {time.zone}</span>
        </div>
        <div class="chart-scroll">
          <div class="chart" role="table" aria-label={`${selected.label} maintenance schedule`}>
            <div class="chart-axis" role="row"><span role="columnheader">Work</span><div class="axis-times" role="columnheader" aria-label="Scheduled time">{#each ticks as tick}<span style:left={`${percent(tick)}%`}>{time.time(tick)}</span>{/each}</div></div>
            {#each model.inputs.jobs as job (job.key)}
              {@const row = rowFor(job.key)}
              {@const element = mapElement(job.key)}
              <div class="chart-row" role="row">
                <div class="job-name" role="rowheader">{#if element}<a href={plantHref(element)} target="_top">{job.title}</a>{:else}{job.title}{/if}{#if row}<span class="job-time">{time.time(row.start)}–{time.time(row.finish)}</span>{/if}</div>
                <div class="job-track" role="cell">
                  {#if targetTime !== null}<span class="target-line" style:left={`${percent(targetTime)}%`}></span>{/if}
                  {#if row}<div class="job-bar" class:work={job.key === 'pump-work' || job.key === 'hx-work'} style:left={`${percent(Date.parse(row.start))}%`} style:width={`${percent(Date.parse(row.finish)) - percent(Date.parse(row.start))}%`}>
                    <span class="sr-only">{time.time(row.start)}–{time.time(row.finish)}</span>
                  </div>{:else}<span class="hint">No checked dates</span>{/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
        <p class="schedule-result" aria-live="polite">
          {#if savedTime !== null && savedTime > 0 && selected.variant.purchases.includes(extraMaintenanceCrew)}
            The extra crew brings the finish forward by {spanText(savedTime)}. Pump work and heat-exchanger work run together.
          {:else}
            One crew does the pump work and heat-exchanger work one after the other.
          {/if}
          {#if targetTime !== null}The dashed line marks the {time.time(targetTime)} target.{/if}
        </p>
        <details class="basis"><summary>What the schedule uses</summary>
          <p>World reports Train B’s component cooling water pump {backup?.value === true ? 'running' : backup?.value === false ? 'stopped' : 'with running state unavailable'}{flow !== undefined && typeof flow.value === 'number' ? ` at ${quantityText(flow.value, flow.unit ?? 'kg/s')}` : ''}{flow === undefined ? '' : `, read at ${time.when(flow.at)}`}. Train B is kept outside this plan’s work scope.</p>
          <p>The work durations, {extraBooking === undefined ? 'extra-crew booking' : `${moneyText(extraBooking, model.inputs.settings.currency)} fixed extra-crew booking`} and target are authored for this exercise. Each displayed schedule passed the independent constraint checker. Work in the schedule is a forecast.</p>
          <a href={plantHref('componentCoolingWaterPumpB')} target="_top">Inspect Pump B in World</a>
        </details>
      </section>

      <section class="engineering" aria-labelledby="cooling-calculation-title">
        <div><h2 id="cooling-calculation-title">Estimate heat transport</h2><p>Ask the agent to read Pump B’s simulated flow and calculate heat transport for an assumed 10 K water-temperature rise.</p></div>
        <button type="button" class="primary" disabled={asking} onclick={() => void ask()}>{asking ? 'Opening Assistant…' : 'Ask Assistant to calculate'}</button>
        {#if agentError}<p class="error" role="alert">{agentError}</p>{/if}
        <details><summary>Review the calculation request</summary><p class="request">{prompt}</p></details>
      </section>
    {/if}

    <footer><a href={planHref(model.id)} target="_top">Open full plan</a><button type="button" class="link" disabled={loading} onclick={() => void recalculate()}>Recalculate comparison</button></footer>
  {/if}
</main>

<style>
  .maintenance { max-width: 1060px; padding: 24px clamp(16px, 3vw, 32px) 36px; margin: auto; }
  header > a { font-size: 12px; }
  a { color: var(--accent); text-underline-offset: 3px; }
  .eyebrow { margin: 14px 0 5px; }
  h1 { font-size: clamp(24px, 3vw, 32px); }
  .question { font-size: 20px; font-weight: 600; margin: 8px 0 4px; }
  .brief { color: var(--ink-2); max-width: 76ch; margin-bottom: 16px; }
  .plant-state { color: var(--ink-2); font-size: 12px; margin: 0 0 10px; }
  .progress { padding: 18px; border: 1px solid var(--line); background: var(--card); border-radius: 8px; }
  .comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
  .crew-option { display: grid; gap: 3px; text-align: left; padding: 15px 18px; border-radius: 9px; border: 1px solid var(--line); }
  .crew-option[aria-pressed='true'] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-2); }
  .option-title { font-weight: 650; }
  .finish-time { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .target-result { color: var(--good); font-size: 13px; }
  .target-result.late { color: var(--warning); }
  .cost { font-size: 12px; color: var(--ink-2); }
  .gantt { padding: 16px 18px; border: 1px solid var(--line); border-radius: 9px; background: var(--card); }
  .schedule-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 12px; margin-bottom: 10px; }
  h2 { margin: 0; font-size: 17px; }
  .schedule-head > span { font-size: 11px; color: var(--ink-3); }
  .chart-scroll { overflow-x: auto; padding-right: 14px; }
  .chart { min-width: 580px; }
  .chart-axis, .chart-row { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 12px; }
  .chart-axis { font-size: 11px; color: var(--ink-3); height: 25px; }
  .axis-times { position: relative; }
  .axis-times > span { position: absolute; transform: translateX(-50%); }
  .axis-times > span:first-child { transform: none; }
  .chart-row { align-items: center; min-height: 43px; border-top: 1px solid var(--line-2); }
  .job-name { font-size: 12px; line-height: 1.3; }
  .job-time { display: block; margin-top: 2px; font-size: 10px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .job-track { height: 42px; position: relative; }
  .target-line { position: absolute; top: 0; bottom: 0; border-left: 2px dashed var(--warning); z-index: 2; pointer-events: none; }
  .job-bar { position: absolute; top: 9px; height: 24px; border-radius: 3px; background: var(--accent-2); border: 1px solid var(--accent); color: var(--ink); }
  .job-bar.work { background: var(--accent); color: var(--on-accent); }
  .schedule-result { font-size: 13px; margin: 10px 0 8px; }
  .basis { padding-top: 8px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-2); }
  summary { cursor: pointer; color: var(--accent); }
  details p { margin: 8px 0; }
  .engineering { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 20px; margin-top: 18px; padding: 16px 18px; border: 1px solid var(--line); border-radius: 9px; background: var(--card); }
  .engineering > div { flex: 1 1 340px; }
  .engineering p { color: var(--ink-2); font-size: 13px; margin: 6px 0 0; }
  .engineering > details, .engineering > .error { flex-basis: 100%; font-size: 12px; }
  .request { white-space: pre-line; }
  footer { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 14px; font-size: 12px; }
  @media (max-width: 800px) {
    .maintenance { padding: 16px 14px 28px; }
    .brief { font-size: 13px; }
    .gantt { padding: 12px; }
    .chart-axis, .chart-row { grid-template-columns: 150px minmax(0, 1fr); }
    .chart { min-width: 520px; }
    .crew-option { padding: 12px; }
  }
</style>
