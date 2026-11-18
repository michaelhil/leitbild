<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { refusalText, type ExplainInput, type ExplainResult, type PlanningClient, type WriteResult } from './api.ts'
  import { estimateEdit } from './edit-forms.ts'
  import { finishChain, mostLimiting, partsText, stepParts } from './explain-text.ts'
  import { createTimeFormat } from './format.ts'
  import { activeScheduleLinks, readScheduleExplanation, scheduleAxis, scheduleTaskGroups } from './maintenance-schedule.ts'
  import { createNames, type DatedRow, type PlanModel } from './model.ts'
  import { layoutTimeline } from './timeline-layout.ts'
  import { durationView } from './rules-text.ts'

  let { client, model, option, rows, label, sharedLabel = 'Shared work', target = null, targetLabel = 'Target', proofJobs = new Set<string>(), equipmentHref, previewEnabled = false, clearPreview = 0, rememberKey, validate, onInvalid }: {
    client: PlanningClient
    model: PlanModel
    option: string
    rows: readonly DatedRow[]
    label: string
    sharedLabel?: string
    target?: string | null
    targetLabel?: string
    proofJobs?: ReadonlySet<string>
    equipmentHref?: (equipment: string) => string | null
    previewEnabled?: boolean
    clearPreview?: number
    rememberKey?: string
    /** A retained publication rechecks its exact option, reference and digest around every owner explanation. */
    validate?: () => Promise<void>
    onInvalid?: (cause: unknown) => void
  } = $props()

  let view = $state<'tasks' | 'crews'>('tasks')
  let selected = $state<string | null>(null)
  let why = $state<ExplainResult | null>(null)
  let chain = $state<ExplainResult | null>(null)
  let chainOpen = $state(false)
  let reading = $state(false)
  let chainReading = $state(false)
  let error = $state<string | null>(null)
  let estimate = $state('')
  let preview = $state<WriteResult | null>(null)
  let previewError = $state<string | null>(null)
  let previewing = $state(false)
  let rememberReady = $state(false)
  let sequence = 0
  let chainSequence = 0
  let previewSequence = 0
  let disposed = false
  let inspectorHeading = $state<HTMLHeadingElement>()

  const time = $derived(createTimeFormat(model.inputs.settings.timeZone))
  const names = $derived(createNames(model.inputs))
  const context = $derived({ inputs: model.inputs, names, format: time })
  const layout = $derived(layoutTimeline(model.inputs, rows, time))
  const axis = $derived(layout === null ? { days: [], ticks: [] } : scheduleAxis(layout.from, layout.to, time))
  const groups = $derived(scheduleTaskGroups(model, rows, sharedLabel))
  const job = $derived(model.inputs.jobs.find(item => item.key === selected))
  const row = $derived(rows.find(item => item.job === selected))
  const duration = $derived(job === undefined ? null : durationView(job, model.inputs.world.facts, time))
  const scheduled = $derived(new Set(rows.map(item => item.job)))
  const links = $derived(activeScheduleLinks(model, option, rows))
  const before = $derived(links.filter(link => link.to === selected))
  const after = $derived(links.filter(link => link.from === selected))
  const related = $derived(new Set([...before.map(link => link.from), ...after.map(link => link.to)]))
  const chainJobs = $derived(new Set(chainOpen ? chain?.items.map(item => item.job) ?? [] : []))
  const steps = $derived(chain === null ? [] : finishChain(chain, context))
  const limiting = $derived(chain === null ? null : mostLimiting(chain, context))
  const cause = $derived(why?.items.find(item => item.job === selected))
  const targetAt = $derived(target === null ? null : Date.parse(target))
  const targetInside = $derived(targetAt !== null && layout !== null && targetAt >= layout.from && targetAt <= layout.to)
  const position = (at: string | number): number => layout === null ? 0 : ((typeof at === 'number' ? at : Date.parse(at)) - layout.from) / (layout.to - layout.from) * 100
  const barStyle = (start: string, finish: string): string => `left:${position(start)}%;width:${Math.max(0.5, position(finish) - position(start))}%`
  const rowFor = (key: string): DatedRow | undefined => rows.find(item => item.job === key)
  const assigned = (key: string): string => names.list([...new Set((rowFor(key)?.uses ?? []).map(use => use.resource))], names.resource)
  const inspectable = $derived((job?.equipment ?? []).flatMap(key => {
    const item = model.inputs.equipment.find(equipment => equipment.key === key)
    const href = equipmentHref?.(key)
    return item === undefined || href === undefined || href === null ? [] : [{ label: item.label, href }]
  }))

  const check = async (): Promise<void> => {
    if (validate === undefined) return
    try { await validate() } catch (cause) { onInvalid?.(cause); throw cause }
  }
  const explain = async (input: ExplainInput): Promise<ExplainResult> => {
    return readScheduleExplanation(client, model.id, option, input, check)
  }
  const select = async (key: string): Promise<void> => {
    const next = ++sequence
    selected = key
    why = null
    preview = null
    previewError = null
    previewSequence += 1
    previewing = false
    estimate = String(model.inputs.jobs.find(item => item.key === key)?.duration.value ?? '')
    error = null
    reading = true
    await tick()
    if (disposed || sequence !== next) return
    inspectorHeading?.focus({ preventScroll: true })
    inspectorHeading?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    try {
      const answer = await explain({ ask: 'why-start', job: key })
      if (!disposed && sequence === next) why = answer
    } catch (cause) {
      if (!disposed && sequence === next) error = refusalText(cause, names.any)
    } finally { if (!disposed && sequence === next) reading = false }
  }
  const finish = async (open = !chainOpen): Promise<void> => {
    chainOpen = open
    const next = ++chainSequence
    if (!open) { chain = null; chainReading = false; return }
    chainReading = true
    error = null
    try {
      const answer = await explain({ ask: 'finish' })
      if (!disposed && chainSequence === next) chain = answer
    } catch (cause) {
      if (!disposed && chainSequence === next) error = refusalText(cause, names.any)
    } finally { if (!disposed && chainSequence === next) chainReading = false }
  }
  const previewEstimate = async (): Promise<void> => {
    if (job === undefined || previewing) return
    const built = estimateEdit(job.key, estimate, job.duration.unit, 'assumption', 'Unsaved estimate experiment in the maintenance demonstration.')
    if (!built.ok) { previewError = built.problems.join(' '); return }
    const next = ++previewSequence
    previewing = true
    previewError = null
    preview = null
    try {
      const answer = await client.edit(model.id, model.revision, { preview: true, option, edits: [...built.edits] })
      if (!disposed && next === previewSequence) preview = answer
    } catch (cause) {
      if (!disposed && next === previewSequence) previewError = refusalText(cause, names.any)
    } finally { if (!disposed && next === previewSequence) previewing = false }
  }

  onMount(() => {
    if (rememberKey !== undefined) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(rememberKey) ?? 'null') as { view?: unknown; selected?: unknown; chain?: unknown } | null
        if (saved?.view === 'crews') view = 'crews'
        if (typeof saved?.selected === 'string' && scheduled.has(saved.selected)) void select(saved.selected)
        if (saved?.chain === true) void finish(true)
      } catch { /* Unavailable preference storage does not prevent reading the schedule. */ }
    }
    rememberReady = true
    return () => { disposed = true; sequence += 1; chainSequence += 1 }
  })
  $effect(() => {
    if (!rememberReady || rememberKey === undefined) return
    try { sessionStorage.setItem(rememberKey, JSON.stringify({ view, selected, chain: chainOpen })) } catch { /* Preference only. */ }
  })
  $effect(() => { clearPreview; previewSequence += 1; preview = null; previewError = null; previewing = false })
</script>

<div class="schedule-interaction">
  <div class="toolbar">
    <div class="views" role="group" aria-label="Schedule view">
      <button type="button" aria-pressed={view === 'tasks'} onclick={() => { view = 'tasks' }}>Tasks</button>
      <button type="button" aria-pressed={view === 'crews'} onclick={() => { view = 'crews' }}>Crews and tools</button>
    </div>
    <button type="button" class="finish-button" aria-pressed={chainOpen} disabled={chainReading} onclick={() => void finish()}>{chainReading ? 'Reading finish chain…' : 'What sets the finish'}</button>
  </div>
  <p class="chart-help">{view === 'tasks' ? 'Select a task to inspect its dependencies, assigned crew and start constraints.' : 'Crew rows show scheduled use and off-shift periods. Select work in Tasks to inspect its start constraints.'}</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if layout}
    <div class="schedule-grid" class:inspecting={selected !== null}>
      <div class="chart-scroll">
        <div class="chart" role="table" aria-label={view === 'tasks' ? label : 'Crew and tool schedule'}>
          <div class="axis" role="row">
            <span role="columnheader">{view === 'tasks' ? 'Work' : 'Crew / tool'}</span>
            <div class="axis-track" role="columnheader" aria-label="Scheduled date and time">
              {#each axis.days as day}<span class="day" style:left={`${day.left}%`} style:width={`${day.width}%`}>{day.label}</span>{/each}
              {#each axis.ticks as tick, index}<span class="schedule-tick" class:first={index === 0} class:last={index === axis.ticks.length - 1} style:left={`${tick.left}%`}>{tick.label}</span>{/each}
            </div>
          </div>
          {#if view === 'tasks'}
            {#each groups as group}
              <div class="group-row" role="row"><span role="cell" aria-colspan="2">{group.label}</span></div>
              {#each group.jobs as task (task.key)}
                {@const dated = rowFor(task.key)}
                {#if dated}
                  <div class="chart-row" role="row" class:selected={selected === task.key} class:related={selected !== task.key && related.has(task.key)} class:chain={chainJobs.has(task.key)} class:proof={proofJobs.has(task.key)}>
                    <div class="job-name" role="rowheader">
                      <button type="button" class="task-name" aria-pressed={selected === task.key} onclick={() => void select(task.key)}>{task.title}</button>
                      <small>{time.range(dated.start, dated.finish)}</small>
                    </div>
                    <div class="track" role="cell">
                      {#each axis.days.slice(1) as day}<span class="day-line" style:left={`${day.left}%`}></span>{/each}
                      {#if targetInside && targetAt !== null}<span class="target-line" style:left={`${position(targetAt)}%`} title={`${targetLabel} ${time.when(targetAt)}`}></span>{/if}
                      <button type="button" class="task-bar kind-{task.kind}" style={barStyle(dated.start, dated.finish)} title={`${task.title} · ${time.range(dated.start, dated.finish)} · ${assigned(task.key)}`} aria-label={`Select ${task.title}, ${time.range(dated.start, dated.finish)}, ${assigned(task.key)}`} onclick={() => void select(task.key)}><span class="sr-only">{task.title}</span></button>
                    </div>
                  </div>
                {/if}
              {/each}
            {/each}
          {:else}
            {#each layout.loads as crew}
              <div class="chart-row crew-row" role="row">
                <div class="job-name" role="rowheader"><strong>{crew.label}</strong><small>{crew.capacity} · {crew.summary}</small></div>
                <div class="track crew-track" role="cell">
                  {#each crew.offShift as gap}<span class="off-shift" style:left={`${gap.left}%`} style:width={`${gap.width}%`} title="Off shift"></span>{/each}
                  {#each axis.days.slice(1) as day}<span class="day-line" style:left={`${day.left}%`}></span>{/each}
                  {#if targetInside && targetAt !== null}<span class="target-line" style:left={`${position(targetAt)}%`}></span>{/if}
                  {#each crew.segments as segment}<span class="load-bar" class:bought={segment.bought} class:over={segment.over} style:left={`${segment.left}%`} style:width={`${segment.width}%`} title={segment.text}>{segment.count > 1 ? segment.count : ''}<span class="sr-only">{segment.text}</span></span>{/each}
                </div>
              </div>
            {/each}
          {/if}
        </div>
        <p class="legend">{#if targetAt !== null}{targetInside ? 'Dashed line · ' : ''}{targetLabel} {time.when(targetAt)}{targetInside ? '.' : ' lies outside the shown work window.'} {/if}{view === 'crews' ? 'Hatching · off shift. Gold · purchased time.' : 'Outline · selected task; pale highlight · its direct dependencies.'}</p>
        {#if proofJobs.size > 0}<p class="legend">Red outlines mark tasks named by the infeasibility proof.</p>{/if}
      </div>

      {#if job}
        <section class="inspector" aria-label="Task details">
          <div class="inspector-heading"><h3 bind:this={inspectorHeading} tabindex="-1">{job.title}</h3><button type="button" class="quiet" aria-label="Close task details" onclick={() => { selected = null; sequence += 1; previewSequence += 1; why = null; preview = null }}>Close</button></div>
          {#if row}<p class="planned">{time.range(row.start, row.finish)}</p><p class="who">{assigned(job.key)}</p>{/if}
          {#if duration}<p class="duration">{duration.text}{duration.source === null ? '' : ` · ${duration.source}`}</p>{/if}
          {#if reading}<p role="status">Reading why this task starts then…</p>
          {:else if cause}<div class="start-cause"><strong>Why it starts then</strong><p>{partsText(stepParts(cause, context))}</p></div>
          {:else if why}<p>{why.lines.join(' ')}</p>{/if}
          {#if before.length > 0}<div class="dependencies"><h4>Predecessors</h4>{#each before as link}<button type="button" class="link" onclick={() => void select(link.from)}>{names.job(link.from)}</button>{/each}</div>{/if}
          {#if after.length > 0}<div class="dependencies"><h4>Successors</h4>{#each after as link}<button type="button" class="link" onclick={() => void select(link.to)}>{names.job(link.to)}</button>{/each}</div>{/if}
          {#if inspectable.length > 0}<div class="world-links">{#each inspectable as item}<a href={item.href} target="_top">Inspect {item.label} in World</a>{/each}</div>{/if}
          {#if previewEnabled && job.kind === 'work' && job.duration.origin.by !== 'world'}
            <form class="estimate" onsubmit={(event) => { event.preventDefault(); void previewEstimate() }}>
              <h4>Try another estimate</h4>
              <label>Duration ({job.duration.unit})<input inputmode="decimal" bind:value={estimate} required /></label>
              <button type="submit" disabled={previewing}>{previewing ? 'Checking preview…' : 'Preview impact'}</button>
              <p class="hint">Repairs this option’s current order. Does not save or search for a different schedule.</p>
            </form>
          {/if}
          {#if previewError}<p class="error" role="alert">{previewError}</p>{/if}
          {#if preview?.preview}
            <section class="estimate-result" aria-label="Estimate preview">
              <h4>Estimate preview</h4><p>Unsaved estimate preview of the selected checked order.</p>
              <p>{preview.preview.consequence}</p>
              {#if preview.preview.violations.length > 0}<ul class="violations">{#each preview.preview.violations as violation}<li>{violation}</li>{/each}</ul>{/if}
              {#if preview.problems.length > 0}<ul>{#each preview.problems as problem}<li>{problem.text}</li>{/each}</ul>{/if}
              {#if (preview.preview.moved?.length ?? 0) > 0}<details><summary>Moved tasks returned by Planning</summary><ul>{#each preview.preview.moved ?? [] as moved}<li>{names.job(moved.job)} · {time.range(moved.start, moved.finish)}</li>{/each}</ul><p class="hint">This list may show only part of the affected work.</p></details>{/if}
              <button type="button" class="quiet" onclick={() => { preview = null; estimate = String(job?.duration.value ?? '') }}>Discard preview</button>
            </section>
          {/if}
        </section>
      {/if}
    </div>
  {/if}
  {#if chainOpen && chain}
    <section class="finish-chain" aria-label="Returned finish chain">
      <h3>What sets the finish</h3>
      {#if limiting}<p>{partsText(limiting.parts)}</p>{/if}
      <p class="hint">Highlighted tasks are the finish chain returned by Planning. Other constraints may also bind.</p>
      <ol>{#each steps as step}<li><button type="button" class="link" onclick={() => void select(step.jobKey)}>{step.job}</button> · {step.when}<small>{step.because}</small></li>{/each}</ol>
    </section>
  {/if}
</div>

<style>
  .toolbar, .views, .inspector-heading { display: flex; align-items: center; gap: 7px; }
  .toolbar { flex-wrap: wrap; justify-content: space-between; margin: 10px 0 5px; }
  .toolbar button { font-size: 12px; padding: 7px 10px; }
  .views button[aria-pressed='true'], .finish-button[aria-pressed='true'] { background: var(--accent-2); border-color: var(--accent); }
  .chart-help, .hint, .legend { color: var(--ink-2); font-size: 11px; }
  .chart-help { margin: 6px 0 10px; }
  .schedule-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .schedule-grid.inspecting { grid-template-columns: minmax(0, 1fr) 290px; }
  .chart-scroll { overflow-x: auto; padding-right: 10px; }
  .chart { min-width: 610px; }
  .axis, .chart-row, .group-row { display: grid; grid-template-columns: minmax(180px, 220px) minmax(370px, 1fr); gap: 12px; }
  .axis { height: 44px; font-size: 10px; color: var(--ink-2); align-items: end; }
  .axis > span { padding-bottom: 7px; }
  .axis-track { height: 44px; position: relative; }
  .day { position: absolute; top: 0; border-left: 1px solid var(--line); padding: 2px 5px; background: var(--accent-2); height: 22px; white-space: nowrap; overflow: hidden; }
  .schedule-tick { position: absolute; bottom: 3px; transform: translateX(-50%); font-variant-numeric: tabular-nums; }
  .schedule-tick.first { transform: none; }
  .schedule-tick.last { transform: translateX(-100%); }
  .group-row { padding: 6px 0 4px; font-size: 11px; font-weight: 650; border-top: 1px solid var(--line); color: var(--ink-2); }
  .group-row > span:first-child { grid-column: 1 / -1; }
  .chart-row { border-top: 1px solid var(--line-2); align-items: center; min-height: 41px; }
  .chart-row.selected { background: var(--accent-2); }
  .chart-row.related { background: var(--paper); }
  .job-name { font-size: 11px; line-height: 1.2; padding: 4px 0; }
  .task-name { border: 0; background: none; color: var(--ink); text-align: left; padding: 0; font-size: 11px; font-weight: 550; line-height: 1.2; width: 100%; }
  .task-name:hover { text-decoration: underline; }
  small { display: block; font-size: 10px; color: var(--ink-2); margin-top: 3px; }
  .track { position: relative; height: 40px; }
  .day-line { position: absolute; inset-block: 0; border-left: 1px solid var(--line); }
  .target-line { position: absolute; inset-block: 0; border-left: 2px dashed var(--warning); z-index: 2; pointer-events: none; }
  .task-bar { position: absolute; top: 10px; height: 21px; padding: 0; min-width: 4px; background: var(--accent); border: 1px solid var(--accent); border-radius: 3px; }
  .kind-tag-out { background: var(--accent-2); border-style: dashed; }
  .kind-test { background: var(--good-bg); border-radius: 8px; }
  .selected .task-bar { outline: 2px solid var(--ink); outline-offset: 2px; }
  .chain .task-bar { box-shadow: 0 0 0 2px var(--warning); }
  .proof .task-bar { outline: 2px solid var(--refusal); outline-offset: 2px; }
  .chain .task-name { color: var(--warning); }
  .proof .task-name { color: var(--refusal); }
  .crew-row { min-height: 51px; }
  .crew-track { height: 50px; }
  .off-shift { position: absolute; top: 7px; bottom: 7px; background: repeating-linear-gradient(135deg, transparent, transparent 3px, var(--line) 3px, var(--line) 5px); opacity: .65; }
  .load-bar { position: absolute; top: 17px; height: 17px; background: var(--accent); text-align: center; font-size: 10px; color: var(--on-accent); }
  .load-bar.bought { background: var(--warning); }
  .load-bar.over { background: var(--refusal); }
  .legend { margin: 8px 0; }
  .inspector { border: 1px solid var(--line); border-radius: 7px; padding: 12px; align-self: start; background: var(--paper); font-size: 12px; }
  .inspector-heading { justify-content: space-between; align-items: start; }
  h3 { font-size: 14px; margin: 0 0 7px; }
  h4 { font-size: 12px; margin: 10px 0 5px; }
  .quiet { padding: 3px 7px; font-size: 11px; }
  .planned { font-weight: 650; margin: 5px 0; }
  .who, .duration { color: var(--ink-2); font-size: 11px; }
  .start-cause { background: var(--accent-2); padding: 9px; margin-top: 10px; }
  .start-cause p { margin: 5px 0 0; line-height: 1.45; }
  .dependencies .link { display: block; text-align: left; margin: 4px 0; line-height: 1.35; }
  .link { border: 0; background: none; padding: 0; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; font-size: inherit; }
  .world-links { border-top: 1px solid var(--line); margin-top: 10px; padding-top: 9px; }
  .world-links a { display: block; color: var(--accent); font-size: 11px; margin-bottom: 6px; }
  .estimate { border-top: 1px solid var(--line); margin-top: 10px; padding-top: 2px; }
  .estimate label { font-size: 11px; }
  .estimate input { width: 100%; margin-bottom: 7px; }
  .estimate button { font-size: 11px; }
  .estimate-result { border-left: 3px solid var(--warning); padding-left: 9px; margin-top: 13px; font-size: 11px; }
  .estimate-result li { margin-bottom: 6px; }
  .estimate-result ul { padding-left: 16px; }
  .violations, .error { color: var(--refusal); }
  .finish-chain { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 10px; font-size: 12px; }
  .finish-chain ol { padding-left: 20px; }
  .finish-chain li { margin: 9px 0; }
  .finish-chain small { margin-top: 4px; }
  @media (max-width: 1150px) { .schedule-grid.inspecting { grid-template-columns: minmax(0, 1fr); } .inspector { max-width: none; } }
  @media (max-width: 700px) { .axis, .chart-row, .group-row { grid-template-columns: 180px minmax(370px, 1fr); } }
</style>
