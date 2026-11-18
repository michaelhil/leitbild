<script lang="ts">
  import { onMount } from 'svelte'
  import { parseEmbeddedViewFragment, embeddedViewHeightMessageSchema } from '@leitbild/contracts'
  import { scheduleDisplayStateSchema, type ScheduleDisplayResult } from '../api/schedule-display-contract.ts'
  import { refusalText, type PlanningClient } from './api.ts'
  import { createTimeFormat, moneyText, spanText } from './format.ts'
  import { loadPlan, loadRows } from './read-plan.ts'
  import type { DatedRow, PlanModel } from './model.ts'
  import MaintenanceSchedule from './MaintenanceSchedule.svelte'

  let { client, workspaceId }: { client: PlanningClient; workspaceId: string } = $props()
  let reading = $state<ScheduleDisplayResult['schedule'] | null>(null)
  let model = $state<PlanModel | null>(null)
  let rows = $state<readonly DatedRow[]>([])
  let reasons = $state<readonly string[]>([])
  let error = $state<string | null>(null)
  let loading = $state(true)
  let root: HTMLElement
  let readSequence = 0
  let publication = $state<{ plan: string; option: string; reference: string | null; digest: string } | null>(null)
  let guard = $state<{ validate: () => Promise<void>; invalid: (cause: unknown) => void } | null>(null)

  const time = $derived(createTimeFormat(reading?.plan.timeZone ?? null))
  const deadline = $derived(reading?.deadline === null || reading?.deadline === undefined ? null : Date.parse(reading.deadline.finishBy))
  const shown = $derived(reading?.option.status.word === 'validated feasible' ? reading.option : reading?.reference)
  const finish = $derived(shown?.finish === null || shown?.finish === undefined ? null : Date.parse(shown.finish))
  const dueRow = $derived(rows.find(row => row.job === reading?.deadline?.job))
  const dueFinish = $derived(dueRow === undefined ? null : Date.parse(dueRow.finish))
  const dueJob = $derived(model?.inputs.jobs.find(job => job.key === reading?.deadline?.job))
  const start = $derived(reading?.plan.window === null || reading?.plan.window === undefined ? 0 : Date.parse(reading.plan.window.start))
  const certificateJobs = $derived(new Set(reading?.certificate?.kind === 'temporal' ? reading.certificate.steps.map(step => step.job)
    : reading?.certificate !== null && reading?.certificate !== undefined && 'jobs' in reading.certificate ? reading.certificate.jobs : []))

  const read = async (): Promise<void> => {
    const sequence = ++readSequence
    loading = true
    error = null
    try {
      const envelope = parseEmbeddedViewFragment(location.hash)
      if (envelope.moduleId !== 'planning' || envelope.viewType !== 'planning.schedule'
        || envelope.subject.workspaceId !== workspaceId || envelope.subject.type !== 'planning.plan') {
        throw new Error('This schedule view belongs to a different plan or Workspace.')
      }
      const state = scheduleDisplayStateSchema.parse(JSON.parse(envelope.state))
      if (envelope.subject.id !== state.plan) throw new Error('The schedule view names a different plan.')
      const answer = await client.display(state.plan, { option: state.option, digest: state.digest, reference: state.reference })
      const schedule = answer.schedule
      const next = await loadPlan(client, state.plan)
      const shownKey = schedule.option.status.word === 'validated feasible' ? schedule.option.key : schedule.reference?.key
      const dated = shownKey === undefined ? [] : next.rows[shownKey] ?? await loadRows(client, state.plan, shownKey)
      const explanation = schedule.option.status.word === 'proven infeasible'
        ? (await client.explain(state.plan, { ask: 'refusal', option: state.option })).lines : []
      // Jobs and rows use Planning's existing paged reads. Recheck the exact
      // publication after reading them so a changed option cannot mix dates.
      await client.display(state.plan, { option: state.option, digest: state.digest, reference: state.reference })
      if (sequence !== readSequence) return
      model = next
      rows = dated
      reasons = explanation
      reading = schedule
      publication = state
      const pin = { ...state }
      guard = {
        validate: async () => { await client.display(pin.plan, { option: pin.option, digest: pin.digest, reference: pin.reference }) },
        invalid: cause => { if (readSequence === sequence) error = refusalText(cause) },
      }
    } catch (cause) {
      if (sequence === readSequence) error = refusalText(cause)
    } finally {
      if (sequence === readSequence) loading = false
    }
  }

  onMount(() => {
    void read()
    const changed = (): void => { void read() }
    window.addEventListener('hashchange', changed)
    const observer = new ResizeObserver(() => {
      if (window.parent === window) return
      const height = Math.max(120, Math.min(960, Math.ceil(root.getBoundingClientRect().height)))
      window.parent.postMessage(embeddedViewHeightMessageSchema.parse({ type: 'leitbild:view-height', height }), location.origin)
    })
    observer.observe(root)
    return () => {
      readSequence += 1
      window.removeEventListener('hashchange', changed)
      observer.disconnect()
    }
  })
</script>

<main bind:this={root} class="schedule-view">
  {#if loading}<p role="status">Reading the checked schedule…</p>{/if}
  {#if error}<div class="error" role="alert"><p>{error}</p><button type="button" onclick={() => void read()}>Read again</button></div>{/if}
  {#if reading && model && !loading && !error}
    <header>
      <p class="eyebrow">{reading.plan.title}</p>
      <h1>{reading.option.label}</h1>
      <p class="date">{reading.plan.window === null ? '' : `${time.day(start)} · `}{time.zoneSet ? time.zone : 'Time zone not set'}</p>
      {#if deadline !== null}<p class="requested">Requested finish by <strong>{time.when(deadline)}</strong>{dueJob === undefined ? '' : ` · ${dueJob.title}`}</p>{/if}
      <p class="verdict" class:checked={reading.option.fresh && reading.option.status.word === 'validated feasible'} class:refused={reading.option.status.word === 'proven infeasible'}>
        {#if !reading.option.fresh}This option needs a new check against the current plan.
        {:else if reading.option.status.word === 'validated feasible'}
          {#if finish !== null}Checked finish <strong>{time.when(finish)}</strong>. {#if deadline !== null && dueFinish !== null}{dueFinish <= deadline ? 'Meets the requested deadline.' : 'Finishes after the requested deadline.'}{/if}{/if}
        {:else if reading.option.status.word === 'proven infeasible'}{deadline === null ? 'This option is proven infeasible under the recorded constraints.' : 'The requested deadline is proven infeasible for this option.'}
        {:else}{reading.option.status.word}{/if}
      </p>
      {#if shown?.cost !== null && shown?.cost !== undefined}<p class="cost">{reading.reference === null ? 'Extra cost' : 'Reference schedule extra cost'} {moneyText(shown.cost, reading.plan.currency)}</p>{/if}
    </header>

    {#if reasons.length > 0}<ul class="reasons">{#each reasons as reason}<li>{reason}</li>{/each}</ul>{/if}
    {#if reading.reference}
      <p class="reference">Checked reference schedule · {reading.reference.label} · finishes {time.when(reading.reference.finish)}{deadline === null || dueFinish === null ? '' : ` · ${spanText(Math.abs(dueFinish - deadline))} ${dueFinish > deadline ? 'after' : 'before'} the requested deadline`}</p>
    {/if}
    {#if rows.length > 0}
      <section aria-label="Checked schedule" class="gantt">
        {#if shown && guard}
          {#key `${publication?.digest}:${shown.key}`}
            <MaintenanceSchedule {client} {model} option={shown.key} {rows} label="Checked work schedule" target={reading.deadline?.finishBy ?? null} targetLabel="Requested deadline" proofJobs={certificateJobs} validate={guard.validate} onInvalid={guard.invalid} />
          {/key}
        {/if}
      </section>
    {/if}
    <footer>Plan revision {reading.option.inputsRevision} · {reading.option.status.word} · forecast using the plan’s recorded inputs</footer>
  {/if}
</main>

<style>
  .schedule-view { padding: 18px; background: var(--paper); }
  h1 { font-size: 21px; }
  .date, .cost, footer { font-size: 11px; color: var(--ink-2); }
  .date { margin-bottom: 10px; }
  .requested { margin-bottom: 8px; }
  .verdict { padding: 10px 12px; background: var(--card); border-left: 3px solid var(--line); }
  .verdict.checked { background: var(--good-bg); border-color: var(--good); }
  .verdict.refused { background: var(--refusal-bg); border-color: var(--refusal); }
  .reasons { font-size: 12px; padding-left: 18px; }
  .reference { padding: 8px 10px; border: 1px solid var(--line); font-size: 12px; }
  footer { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 8px; }
</style>
