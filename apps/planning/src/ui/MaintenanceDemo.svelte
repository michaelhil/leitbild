<script lang="ts">
  import { onMount } from 'svelte'
  import type { WorkspaceResourceReference } from '@leitbild/contracts'
  import { refusalText, type PlanningClient } from './api.ts'
  import { createTimeFormat, moneyText, quantityText, spanText } from './format.ts'
  import { planOptions, type DatedRow, type OptionView, type PlanModel } from './model.ts'
  import { loadPlan, loadRows } from './read-plan.ts'
  import MaintenanceSchedule from './MaintenanceSchedule.svelte'
  import { extraMaintenanceCrew, maintenanceCost, maintenanceDefinitionId, maintenanceEquipmentElement, maintenanceFinish, maintenancePlantId, maintenancePrompt, maintenanceQuestion, maintenanceVariantsFor } from './maintenance-demo.ts'

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
  let question = $state('')
  let agentError = $state<string | null>(null)
  let clearPreview = $state(0)
  let controller: AbortController | null = null
  const noCheckedSchedule = 'No current checked schedule is available. Open the full plan to inspect its inputs, or try calculating the comparison again.'

  const time = $derived(createTimeFormat(model?.inputs.settings.timeZone ?? null))
  const options = $derived(model === null ? [] : planOptions(model).toSorted((left, right) =>
    Number(left.variant.purchases.includes(extraMaintenanceCrew)) - Number(right.variant.purchases.includes(extraMaintenanceCrew))))
  const selected = $derived(options.find(option => option.key === selectedKey))
  const rows = $derived(selectedKey === null ? [] : schedules[selectedKey] ?? [])
  const finish = $derived(maintenanceFinish(rows))
  const window = $derived(model?.inputs.settings.window)
  const start = $derived(window === null || window === undefined ? 0 : Date.parse(window.start))
  const target = $derived(model?.inputs.jobs.find(job => job.key === 'restore')?.target?.finishBy)
  const targetTime = $derived(target === undefined ? null : Date.parse(target))
  const oneCrew = $derived(options.find(option => !option.variant.purchases.includes(extraMaintenanceCrew)))
  const extraCrew = $derived(options.find(option => option.variant.purchases.includes(extraMaintenanceCrew)))
  const baselineFinish = $derived(oneCrew === undefined ? null : maintenanceFinish(schedules[oneCrew.key] ?? []))
  const extraFinish = $derived(extraCrew === undefined ? null : maintenanceFinish(schedules[extraCrew.key] ?? []))
  const savedTime = $derived(baselineFinish === null || extraFinish === null ? null : baselineFinish - extraFinish)
  const backup = $derived(model?.inputs.world.facts.find(fact => fact.id === `${maintenancePlantId}/componentCoolingWaterPumpB/runningState`))
  const serviceBackup = $derived(model?.inputs.world.facts.find(fact => fact.id === `${maintenancePlantId}/serviceWaterPumpB/runningState`))
  const bothProtected = $derived(model?.inputs.rules.some(rule => rule.kind === 'protected' && rule.equipment.includes('SWB') && rule.equipment.includes('CCWB')) ?? false)
  const hardDeadline = $derived(model?.inputs.rules.find(rule => rule.kind === 'due' && rule.job === 'restore'))
  const flow = $derived(model?.inputs.world.facts.find(fact => fact.id === `${maintenancePlantId}/componentCoolingWaterPumpB/flowKgPerS`))
  const extraBooking = $derived(model?.inputs.purchases.find(purchase => purchase.key === extraMaintenanceCrew)?.price.once)
  const prompt = $derived(model !== null && selected !== undefined ? maintenancePrompt(model, selected) : '')
  const optionFinish = (option: OptionView): number | null => maintenanceFinish(schedules[option.key] ?? [])
  const plantHref = (elementId?: string): string => worldHref(maintenancePlantId, elementId, selectedKey ?? undefined)

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
    if (question === '') question = `Can we complete maintenance by ${createTimeFormat(next.inputs.settings.timeZone).when(next.inputs.jobs.find(job => job.key === 'restore')!.target!.finishBy)}?`
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
        await client.generate(current.id, current.revision, maintenanceVariantsFor(current), pending.signal)
        await read(current.id)
      }
      if (pending.signal.aborted) return
      const shown = model
      if (shown === null || !planOptions(shown).some(option => option.fresh && option.status.word === 'validated feasible')) {
        throw new Error(noCheckedSchedule)
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
      const before = await read(model.id)
      await client.refresh(before.id, before.revision)
      const current = await read(before.id)
      await client.generate(current.id, current.revision, maintenanceVariantsFor(current), pending.signal)
      const checked = await read(current.id)
      if (!planOptions(checked).some(option => option.fresh && option.status.word === 'validated feasible')) throw new Error(noCheckedSchedule)
    } catch (cause) {
      if (!pending.signal.aborted) error = refusalText(cause)
    } finally {
      controller = null
      loading = false
    }
  }

  const ask = async (request: string, title: string): Promise<void> => {
    if (model === null || selected === undefined || asking) return
    asking = true
    agentError = null
    clearPreview += 1
    try {
      const room = await client.askAssistant(model.id, run, request, title)
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
    <p class="brief">{model?.inputs.settings.purpose ?? 'Prepare the maintenance work window and compare checked schedules.'}</p>
    {#if model && !loading}
      {#if model.inputs.settings.window}<p class="window">{time.when(model.inputs.settings.window.start)} – {time.when(model.inputs.settings.window.end)} · {time.zone}{target === undefined ? '' : ` · target ${time.when(target)}`}{hardDeadline?.kind === 'due' ? ` · hard finish limit ${time.when(hardDeadline.finishBy)}` : ''}</p>{/if}
      <form class="deadline-question" onsubmit={(event) => { event.preventDefault(); if (model !== null && question.trim() !== '') void ask(maintenanceQuestion(model, question.trim()), 'Maintenance scheduling') }}>
        <label for="maintenance-question">Ask about the deadline</label>
        <div class="question-controls"><input id="maintenance-question" bind:value={question} required /><button type="submit" class="primary" disabled={asking || question.trim() === ''}>{asking ? 'Opening Assistant…' : 'Ask Assistant'}</button></div>
      </form>
      {#if agentError}<p class="error" role="alert">{agentError}</p>{/if}
    {/if}
  </header>

  {#if loading}<p class="progress" role="status">{model === null ? 'Reading the plant and preparing the work plan…' : 'Calculating and checking both crew schedules…'}</p>{/if}
  {#if error}
    <div class="error" role="alert"><p>{error}</p><button type="button" disabled={loading} onclick={() => void (model === null ? prepare() : recalculate())}>Try again</button></div>
  {/if}

  {#if model && !loading}
    <p class="plant-state">World reports CCW B {backup?.value === true ? 'running' : backup?.value === false ? 'stopped' : 'with running state unavailable'}{serviceBackup === undefined && flow !== undefined && typeof flow.value === 'number' ? ` at ${quantityText(flow.value, flow.unit ?? 'kg/s')}` : ''}{serviceBackup === undefined ? '' : ` and SW B ${serviceBackup.value === true ? 'running' : serviceBackup.value === false ? 'stopped' : 'with running state unavailable'}`}. {bothProtected ? 'Both B pumps are protected from planned work.' : ''} <a href={plantHref('componentCoolingWaterPumpB')} target="_top">Inspect in World</a></p>
    <section aria-label="Compare crew schedules" class="comparison">
      {#each options as option (option.key)}
        {@const done = optionFinish(option)}
        {@const cost = maintenanceCost(model, option)}
        <button type="button" class="crew-option" aria-pressed={selectedKey === option.key} onclick={() => { selectedKey = option.key }} disabled={done === null || !option.fresh}>
          <span class="option-title">{option.label}</span>
          {#if done !== null}
            <span class="finish-time">Finish {time.when(done)}</span>
            <span class="target-result" class:late={targetTime !== null && done > targetTime}>
              {#if targetTime !== null}{spanText(Math.abs(done - targetTime))} {done > targetTime ? 'after' : 'before'} {time.when(targetTime)}{/if}
            </span>
          {:else}<span>{option.fresh ? option.status.word : 'Needs a current check'}</span>{/if}
          <span class="cost">{cost === null ? 'Cost unavailable' : cost === 0 ? 'No extra booking cost' : `+ ${moneyText(cost, model.inputs.settings.currency)}`}</span>
        </button>
      {/each}
    </section>

    {#if selected && finish !== null}
      <section class="gantt" aria-label="Maintenance schedule">
        <div class="schedule-head">
          <h2 id="maintenance-schedule-title">{selected.label} schedule</h2>
          <span>{time.day(start)} · {time.zone}</span>
        </div>
        {#key `${selected.key}:${model.revision}:${model.options?.at}`}
          <MaintenanceSchedule {client} {model} option={selected.key} {rows} label={`${selected.label} maintenance schedule`} sharedLabel="Shared gates and return to service" target={target ?? null} previewEnabled {clearPreview} equipmentHref={key => { const element = maintenanceEquipmentElement(key); return element === null ? null : worldHref(maintenancePlantId, element, selected.key) }} rememberKey={`maintenance:${client.workspaceId}:${model.id}:${selected.key}`} />
        {/key}
        <p class="schedule-result" aria-live="polite">
          {#if savedTime !== null && savedTime > 0 && selected.variant.purchases.includes(extraMaintenanceCrew)}
            This option finishes {spanText(savedTime)} earlier than {oneCrew?.label.toLowerCase()}. Use “What sets the finish” to inspect the actual deciding chain.
          {/if}
          {#if targetTime !== null}The dashed line marks the {time.when(targetTime)} target.{/if}
        </p>
        <details class="basis"><summary>What the schedule uses</summary>
          <p>World reports CCW B {backup?.value === true ? 'running' : backup?.value === false ? 'stopped' : 'with running state unavailable'}{flow !== undefined && typeof flow.value === 'number' ? ` at ${quantityText(flow.value, flow.unit ?? 'kg/s')}` : ''}{flow === undefined ? '' : `, read at ${time.when(flow.at)}`}.{serviceBackup === undefined ? '' : ` SW B is ${serviceBackup.value === true ? 'running' : serviceBackup.value === false ? 'stopped' : 'with running state unavailable'}, read at ${time.when(serviceBackup.at)}.`} {bothProtected ? 'Both B pumps are protected from planned work.' : 'Pump B is kept outside this plan’s work scope.'}</p>
          <p>The work durations, qualifications, calendars, {extraBooking === undefined ? 'extra crew cost' : `${moneyText(extraBooking, model.inputs.settings.currency)} extra crew cost`} and target are authored planning assumptions. Each displayed schedule passed the independent constraint checker. Scheduled gates forecast reviews and release handoffs by their responsible roles.</p>
          <p>The forecast assumes parts and access are ready and inspections and tests pass.</p>
          <a href={plantHref('componentCoolingWaterPumpB')} target="_top">Inspect CCW Pump B in World</a>
        </details>
      </section>

      <section class="engineering" aria-labelledby="cooling-calculation-title">
        <div><h2 id="cooling-calculation-title">Estimate heat transport</h2><p>Ask the agent to read CCW Pump B’s simulated flow and calculate heat transport for an assumed 10 K water-temperature rise.</p></div>
        <button type="button" disabled={asking} onclick={() => void ask(prompt, 'Cooling-water calculation')}>Ask Assistant to calculate</button>
        <details><summary>Review the calculation request</summary><p class="request">{prompt}</p></details>
      </section>
    {/if}

    <footer><a href={planHref(model.id)} target="_top">Open full plan</a><button type="button" class="link" disabled={loading} onclick={() => void recalculate()}>Recalculate comparison</button></footer>
  {/if}
</main>

<style>
  .maintenance { max-width: 1380px; padding: 18px clamp(16px, 2.5vw, 30px) 32px; margin: auto; }
  header > a { font-size: 12px; }
  a { color: var(--accent); text-underline-offset: 3px; }
  .eyebrow { margin: 12px 0 4px; }
  h1 { font-size: clamp(24px, 3vw, 30px); }
  .brief { color: var(--ink-2); max-width: 100ch; margin: 5px 0 7px; font-size: 13px; }
  .window, .plant-state { color: var(--ink-2); font-size: 11px; margin: 7px 0; }
  .progress { padding: 18px; border: 1px solid var(--line); background: var(--card); border-radius: 8px; }
  .comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 10px 0 12px; }
  .crew-option { display: grid; gap: 2px; text-align: left; padding: 9px 14px; border-radius: 8px; border: 1px solid var(--line); }
  .crew-option[aria-pressed='true'] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-2); }
  .option-title { font-weight: 650; font-size: 12px; }
  .finish-time { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .target-result { color: var(--good); font-size: 11px; }
  .target-result.late { color: var(--warning); }
  .cost { font-size: 11px; color: var(--ink-2); }
  .gantt { padding: 14px 16px; border: 1px solid var(--line); border-radius: 9px; background: var(--card); }
  .schedule-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 12px; margin-bottom: 10px; }
  h2 { margin: 0; font-size: 17px; }
  .schedule-head > span { font-size: 11px; color: var(--ink-3); }
  .schedule-result { font-size: 13px; margin: 10px 0 8px; }
  .basis { padding-top: 8px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-2); }
  summary { cursor: pointer; color: var(--accent); }
  details p { margin: 8px 0; }
  .engineering { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 20px; margin-top: 18px; padding: 16px 18px; border: 1px solid var(--line); border-radius: 9px; background: var(--card); }
  .deadline-question { margin: 10px 0 11px; }
  .deadline-question label { font-size: 12px; }
  .question-controls { display: flex; gap: 8px; }
  .question-controls input { flex: 1; }
  .question-controls button { flex-shrink: 0; }
  .engineering > div { flex: 1 1 340px; }
  .engineering p { color: var(--ink-2); font-size: 13px; margin: 6px 0 0; }
  .engineering > details { flex-basis: 100%; font-size: 12px; }
  .request { white-space: pre-line; }
  footer { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 14px; font-size: 12px; }
  @media (max-width: 800px) {
    .maintenance { padding: 16px 14px 28px; }
    .brief { font-size: 13px; }
    .gantt { padding: 12px; }
    .crew-option { padding: 12px; }
  }
</style>
