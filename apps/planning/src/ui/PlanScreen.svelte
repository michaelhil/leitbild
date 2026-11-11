<script lang="ts">
  import { onMount } from 'svelte'
  import type { PlanningSubject } from '@leitbild/contracts'
  import type { Edit } from '../plan/edit-schema.ts'
  import { isRequestError, refusalText, RUN, type GenerateInput, type PlanningClient } from './api.ts'
  import { attentionCards, type CardAction } from './attention.ts'
  import AttentionColumn from './AttentionColumn.svelte'
  import CrewForm from './CrewForm.svelte'
  import EditPreview from './EditPreview.svelte'
  import EquipmentPicker from './EquipmentPicker.svelte'
  import { finishChain, whyStart, type FinishStep, type WhyStart } from './explain-text.ts'
  import { createTimeFormat } from './format.ts'
  import JobForm from './JobForm.svelte'
  import JobPanel from './JobPanel.svelte'
  import { createNames, type PlanModel, type PlanView, type RunChoice } from './model.ts'
  import OptionsTable from './OptionsTable.svelte'
  import PlanHeader from './PlanHeader.svelte'
  import type { Preview } from './preview.ts'
  import RulesPanel from './RulesPanel.svelte'
  import { loadPlan, loadRows } from './sections.ts'
  import { shiftList } from './shift-list.ts'
  import ShiftList from './ShiftList.svelte'
  import StatusBlock from './StatusBlock.svelte'
  import { statusView, type Context } from './status-text.ts'
  import Timeline from './Timeline.svelte'
  import { layoutTimeline } from './timeline-layout.ts'
  import WorkList from './WorkList.svelte'

  let { client, planId, initial = null, initialRuns = [], initialView = 'schedule', onChanged, onOpenWorkspace, onOpenLibrary }: {
    client: PlanningClient
    planId: string
    initial?: PlanModel | null
    initialRuns?: readonly RunChoice[]
    initialView?: PlanView
    onChanged: () => void
    onOpenWorkspace: () => void
    onOpenLibrary: () => void
  } = $props()

  // The initial props seed the screen once (a test renders a plan it already has); later reads replace them.
  // svelte-ignore state_referenced_locally
  let model = $state<PlanModel | null>(initial)
  // svelte-ignore state_referenced_locally
  let runs = $state<readonly RunChoice[]>(initialRuns)
  // svelte-ignore state_referenced_locally
  let view = $state<PlanView>(initialView)
  let selectedJob = $state<string | null>(null)
  // svelte-ignore state_referenced_locally
  let selectedOption = $state<string | null>(initial?.options?.recommended ?? null)
  let busy = $state(false)
  let generating = $state<AbortController | null>(null)
  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let finish = $state<readonly FinishStep[] | null>(null)
  let why = $state<WhyStart | null>(null)
  let preview = $state<Preview | null>(null)
  let pending = $state<readonly Edit[]>([])

  const context = $derived<Context | null>(model === null ? null : { inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
  const rows = $derived(model !== null && selectedOption !== null ? model.rows[selectedOption] ?? [] : [])
  const layout = $derived(model !== null && context !== null ? layoutTimeline(model.inputs, rows, context.format) : null)
  const cards = $derived(model !== null && context !== null ? attentionCards(model, context) : [])
  const shifts = $derived(model !== null && context !== null ? shiftList(model.inputs, rows, context.format) : [])
  const shown = $derived(model?.options?.items.find(option => option.key === selectedOption) ?? null)
  const linkedRun = $derived(model?.inputs.settings.run ? runs.find(run => run.id === model?.inputs.settings.run?.id)?.title ?? null : null)
  const certified = $derived(model?.certifiedSize ? `Generate is certified for ${model.certifiedSize.family} up to ${model.certifiedSize.maxJobs} jobs (${model.certifiedSize.evidence}). This plan has ${model.inputs.jobs.length}.` : null)

  const views: ReadonlyArray<{ key: PlanView; word: string }> = [
    { key: 'schedule', word: 'Schedule' }, { key: 'add', word: 'Add jobs and links' }, { key: 'equipment', word: 'Equipment and World' },
    { key: 'crews', word: 'Crews and shifts' }, { key: 'rules', word: 'Rules and goals' }, { key: 'options', word: 'Options' },
  ]

  const readRuns = async (): Promise<readonly RunChoice[]> => {
    const catalog = await client.catalog()
    const scenario = model?.inputs.settings.scenario?.id
    return catalog.resources.filter(resource => resource.ref.type === RUN).map(resource => ({
      id: resource.ref.id, title: resource.title,
      status: String(resource.summary.find(item => item.key === 'status')?.value ?? ''),
      matches: scenario !== undefined && resource.sourceDefinition?.id === scenario,
    }))
  }
  const reload = async (): Promise<void> => {
    const next = await loadPlan(client, planId)
    const keep = selectedOption !== null && next.options?.items.some(option => option.key === selectedOption) ? selectedOption : next.options?.recommended ?? null
    model = keep !== null && next.rows[keep] === undefined ? { ...next, rows: { ...next.rows, [keep]: await loadRows(client, planId, keep) } } : next
    selectedOption = keep
    finish = null
    why = null
  }
  const attempt = async (work: () => Promise<void>): Promise<void> => {
    busy = true
    error = null
    try { await work() } catch (cause) {
      error = refusalText(cause)
      if (isRequestError(cause) && cause.code === 'plan_revision_conflict') await reload().catch(() => undefined)
    } finally { busy = false }
  }

  onMount(() => {
    void attempt(async () => {
      if (model === null) await reload()
      runs = await readRuns()
    })
  })

  const previewEdits = (edits: readonly Edit[], label: string): void => {
    if (model === null) return
    const revision = model.revision
    void attempt(async () => {
      pending = edits
      try {
        preview = { label, result: await client.edit(planId, revision, { edits: [...edits], preview: true }), refusal: null }
      } catch (cause) {
        if (!isRequestError(cause) || cause.status >= 500) throw cause
        preview = { label, result: null, refusal: { text: refusalText(cause), needsAuthority: cause.code === 'needs_authority' } }
      }
    })
  }
  const readsWorld = (edits: readonly Edit[]): boolean => edits.some(edit => ('locator' in edit && typeof edit.locator === 'string') || (edit.edit === 'plan' && typeof edit.run === 'string'))
  const afterWrite = async (edits: readonly Edit[]): Promise<void> => {
    await reload()
    if (model !== null && model.inputs.settings.run !== null && readsWorld(edits)) {
      await client.refresh(planId, model.revision)
      await reload()
    }
    onChanged()
  }
  const apply = (authority: { name: string; reason: string } | null): void => {
    if (model === null) return
    const revision = model.revision
    const edits = pending
    void attempt(async () => {
      const result = await client.edit(planId, revision, { edits: [...edits], ...(authority === null ? {} : { authority }) })
      preview = null
      notice = result.changed.length > 0 ? result.changed.join(' ') : 'Saved.'
      await afterWrite(edits)
    })
  }
  const useTime = (instant: string): void => {
    const lock = pending.find(edit => edit.edit === 'job' && 'lock' in edit)
    if (lock !== undefined && lock.edit === 'job') previewEdits([{ edit: 'job', key: lock.key, lock: instant }], preview?.label ?? 'Fix the start')
  }
  const link = (run: string): void => {
    if (model === null) return
    const revision = model.revision
    void attempt(async () => {
      await client.edit(planId, revision, { edits: [{ edit: 'plan', run }] })
      notice = 'Linked. Reading its values…'
      await afterWrite([{ edit: 'plan', run }])
      notice = 'Linked, and the World values are read.'
    })
  }
  const refresh = (): void => {
    if (model === null) return
    const revision = model.revision
    void attempt(async () => {
      const result = await client.refresh(planId, revision)
      notice = result.changed.length > 0 ? result.changed.join(' ') : 'World values read; nothing changed.'
      await reload()
      onChanged()
    })
  }
  const generate = (input: GenerateInput): void => {
    if (model === null) return
    const revision = model.revision
    const controller = new AbortController()
    generating = controller
    error = null
    void (async () => {
      try {
        const result = await client.generate(planId, revision, input, controller.signal)
        notice = result.text
        selectedOption = result.recommended ?? selectedOption
      } catch (cause) {
        if (controller.signal.aborted) notice = 'Cancelled. The best plan found before the stop is kept if it is better than the one you had.'
        else error = refusalText(cause)
      } finally {
        generating = null
      }
      await attempt(async () => { await reload(); onChanged() })
    })()
  }
  const showOption = (option: string): void => {
    if (model === null) return
    const current = model
    void attempt(async () => {
      model = current.rows[option] === undefined ? { ...current, rows: { ...current.rows, [option]: await loadRows(client, planId, option) } } : current
      selectedOption = option
      finish = null
      why = null
      view = 'schedule'
    })
  }
  const explainFinish = (): void => {
    if (context === null) return
    const shownContext = context
    void attempt(async () => {
      finish = finishChain(await client.explain(planId, { ask: 'finish', ...(selectedOption === null ? {} : { option: selectedOption }) }), shownContext)
    })
  }
  const explainStart = (job: string): void => {
    if (context === null) return
    const shownContext = context
    void attempt(async () => {
      const result = await client.explain(planId, { ask: 'why-start', job, ...(selectedOption === null ? {} : { option: selectedOption }) })
      const item = result.items.find(entry => entry.job === job)
      why = item === undefined ? null : whyStart(item, shownContext, rows.find(row => row.job === job))
      if (item === undefined) notice = result.lines.join(' ')
    })
  }
  const baseline = (option: string, name: string, note: string): void => {
    if (model === null) return
    const revision = model.revision
    void attempt(async () => {
      await client.baseline(planId, revision, { option, name, ...(note === '' ? {} : { note }) })
      notice = `Baseline “${name}” saved.`
      await reload()
      onChanged()
    })
  }
  const onAction = (action: CardAction): void => {
    if (action === 'open-workspace') onOpenWorkspace()
    else if (action === 'link-run') view = 'equipment'
    else if (action === 'refresh') refresh()
    else if (action === 'add-work') view = 'equipment'
    else if (action === 'generate') generate({})
    else explainFinish()
  }
  const search = async (text: string): Promise<readonly PlanningSubject[]> => {
    const run = model?.inputs.settings.run?.id
    if (run === undefined) return []
    return (await client.facts(run, { text, limit: 10 })).items
  }
  const detail = async (locator: string): Promise<PlanningSubject> => {
    const run = model?.inputs.settings.run?.id
    if (run === undefined) throw new Error('Link a simulation first.')
    const found = (await client.facts(run, { subjects: [locator] })).items.find(item => item.locator === locator)
    if (found === undefined) throw new Error('World no longer has this item.')
    return found
  }
</script>

{#if model !== null && context !== null}
  <div class="plan-screen">
    <p class="back"><button type="button" class="link" onclick={onOpenLibrary}>← All plans</button></p>
    <PlanHeader {context} title={model.title} {certified} generating={generating !== null} {busy} onGenerate={generate} onCancel={() => generating?.abort()} />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if notice}<p class="notice" aria-live="polite">{notice}</p>{/if}
    <div class="screen-grid">
      <div class="col-attention">
        <AttentionColumn {cards} {finish} busy={busy || generating !== null} {onAction} />
        <div class="phone-only"><ShiftList {shifts} /></div>
      </div>
      <div class="col-main">
        <nav class="views" aria-label="Plan views">
          {#each views as item (item.key)}<button type="button" class:current={view === item.key} aria-pressed={view === item.key} onclick={() => { view = item.key }}>{item.word}</button>{/each}
        </nav>
        {#if view === 'schedule'}
          {#if shown}
            <section class="shown-option" aria-labelledby="shown-title">
              <h2 id="shown-title">{shown.label}</h2>
              <StatusBlock view={statusView(shown.status, context)} warnings={shown.warnings.map(warning => warning.text)} stale={!shown.fresh} />
            </section>
          {/if}
          {#if layout}<div class="desktop-only"><Timeline {layout} selected={selectedJob} onSelect={(job) => { selectedJob = job; why = null }} /></div>{/if}
          <WorkList {context} {rows} selected={selectedJob} onSelect={(job) => { selectedJob = job; why = null }} />
        {:else if view === 'add'}
          <JobForm {context} {busy} onPreview={previewEdits} />
        {:else if view === 'equipment'}
          <EquipmentPicker {context} {runs} {linkedRun} {busy} onLink={link} onRefresh={refresh} {onOpenWorkspace} onSearch={search} onDetail={detail} onPreview={previewEdits} />
        {:else if view === 'crews'}
          <CrewForm {context} {busy} onPreview={previewEdits} />
        {:else if view === 'rules'}
          <RulesPanel {context} {busy} onPreview={previewEdits} />
        {:else}
          <OptionsTable options={model.options?.items ?? []} recommended={model.options?.recommended ?? null} {context} selected={selectedOption} {busy} onSelect={showOption} onBaseline={baseline} />
        {/if}
      </div>
      <div class="col-panel">
        {#if preview}
          <EditPreview {preview} {context} {busy} onApply={apply} onDiscard={() => { preview = null }} onUseTime={useTime} />
        {:else if selectedJob}
          <JobPanel jobKey={selectedJob} {context} row={rows.find(row => row.job === selectedJob)} {why} {busy} onWhy={explainStart} onPreview={previewEdits} onClose={() => { selectedJob = null; why = null }} />
        {/if}
      </div>
    </div>
  </div>
{:else if error}
  <div class="plan-screen"><p class="error" role="alert">{error}</p><button type="button" onclick={onOpenLibrary}>← All plans</button></div>
{:else}
  <p class="loading">Opening the plan…</p>
{/if}
