<script lang="ts">
  import { guideControlTargets, guideDefinitionSchema, type GuideDefinition, type GuideStep, type GuideTarget, type GuideCondition } from '../core/guides/model.ts'
  import { quantityUnits, type Quantity } from '../core/observation/model.ts'
  import type { ObjectId } from '../core/model/ids.ts'
  import type { PresentationAction } from '@leitbild/contracts'
  import AdvancedConfiguration from './AdvancedConfiguration.svelte'
  import { loadUiPack } from './pack-loader.ts'

  let { guide, objects, packIds, onchange, oninvalid }: {
    guide: GuideDefinition | undefined
    objects: ReadonlyArray<{ id: string; label: string }>
    packIds: ReadonlyArray<string>
    onchange: (guide: GuideDefinition | undefined) => void
    oninvalid: (invalid: boolean) => void
  } = $props()
  let working = $state<GuideDefinition | undefined>()
  let errors = $state<string[]>([])
  let expandedStepId = $state('')
  let panels = $state<Array<{ id: string; label: string }>>([])
  let panelError = $state('')
  let panelsLoading = $state(false)
  let panelsKey = $state('')
  const panelChoices = $derived(panelsKey === JSON.stringify(packIds) ? panels : [])
  let seen: string | undefined
  const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const issues = (error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) => error.issues.map(issue => `${issue.path.join('.') || 'Guide'}: ${issue.message}`)

  // The parent can replace the whole Scenario through its advanced editor.
  // Echoes of our validated edits must not erase an incomplete local field.
  $effect(() => {
    const next = JSON.stringify(guide)
    if (next === seen) return
    seen = next
    working = guide === undefined ? undefined : copy(guide)
    errors = []
    oninvalid(false)
  })
  const commit = (candidate: GuideDefinition | undefined): void => {
    working = candidate
    if (candidate === undefined) { errors = []; seen = undefined; oninvalid(false); onchange(undefined); return }
    const parsed = guideDefinitionSchema.safeParse(candidate)
    if (!parsed.success) { errors = issues(parsed.error); oninvalid(true); return }
    errors = []; seen = JSON.stringify(parsed.data); oninvalid(false); onchange(parsed.data)
  }
  const edit = (change: (candidate: GuideDefinition) => void): void => {
    if (!working) return
    const candidate = copy(working); change(candidate); commit(candidate)
  }
  const step = (index: number, change: (candidate: GuideStep) => void): void => edit(candidate => change(candidate.steps[index]!))
  const blankStep = (index: number): GuideStep => ({ id: `step-${crypto.randomUUID()}`, title: `Step ${index + 1}`, instruction: '', effects: [], completion: { kind: 'acknowledge' } })
  const addGuide = () => commit({ id: `guide-${crypto.randomUUID()}`, title: 'Scenario guide', startPaused: true, steps: [blankStep(0)] })
  const addStep = () => edit(candidate => { const added = blankStep(candidate.steps.length); expandedStepId = added.id; candidate.steps.push(added) })
  const move = (index: number, by: number) => edit(candidate => { const [moved] = candidate.steps.splice(index, 1); candidate.steps.splice(index + by, 0, moved!) })
  const target = (kind: GuideTarget['kind']): GuideTarget => kind === 'object' ? { kind, objectId: (objects[0]?.id ?? '') as ObjectId }
    : kind === 'panel' ? { kind, panelId: '' } : kind === 'control' ? { kind, controlId: guideControlTargets[0].id } : { kind: 'composer' }
  const condition = (kind: GuideCondition['kind']): GuideCondition => kind === 'clock' ? { kind, afterSeconds: 0 }
    : kind === 'object-status' ? { kind, objectId: (objects[0]?.id ?? '') as ObjectId, status: '' }
    : { kind, ref: '', operator: 'eq', value: true, quantity: 'state', unit: '', maxAgeSeconds: 30 }
  const action = (kind: Exclude<PresentationAction['kind'], 'clear'>): PresentationAction => kind === 'draft' ? { kind, text: '' }
    : kind === 'explain' ? { kind, title: '', text: '' } : { kind }
  const actionChoices = (target: GuideTarget): Array<Exclude<PresentationAction['kind'], 'clear'>> => target.kind === 'composer' ? ['draft'] : target.kind === 'object' ? ['reveal', 'focus', 'highlight', 'explain'] : ['reveal', 'highlight']
  const actionLabels = { reveal: 'Reveal / open', focus: 'Focus on map', highlight: 'Highlight', explain: 'Explain', draft: 'Suggest prompt' }
  const setCompletion = (index: number, kind: GuideStep['completion']['kind']) => step(index, current => {
    current.completion = kind === 'acknowledge' ? { kind } : kind === 'condition' ? { kind, condition: condition('clock') }
      : { kind, effectId: current.effects.find(effect => kind !== 'prompt-response' || effect.action.kind === 'draft')?.id ?? '' }
  })
  const loadPanels = async (): Promise<void> => {
    panelsLoading = true; panelError = ''
    const ids = [...packIds]
    try {
      const loaded = await Promise.all(ids.map(id => loadUiPack(id)))
      if (JSON.stringify(ids) !== JSON.stringify(packIds)) throw new Error('Pack selections changed; load panel choices again')
      panels = loaded.flatMap(pack => pack.ui?.surfacePanels.map(panel => ({ id: panel.id, label: panel.label })) ?? []); panelsKey = JSON.stringify(ids)
    } catch (error) { panelError = error instanceof Error ? error.message : String(error) }
    finally { panelsLoading = false }
  }
  const setTargetKind = (index: number, effectIndex: number, kind: GuideTarget['kind']) => {
    step(index, current => { const effect = current.effects[effectIndex]!; effect.target = target(kind); if (!actionChoices(effect.target).includes(effect.action.kind as Exclude<PresentationAction['kind'], 'clear'>)) effect.action = action(actionChoices(effect.target)[0]!) })
    if (kind === 'panel') void loadPanels()
  }
  const setActionKind = (index: number, effectIndex: number, kind: Exclude<PresentationAction['kind'], 'clear'>) => step(index, current => {
    const effect = current.effects[effectIndex]!; effect.action = action(kind)
    if (kind === 'draft') effect.target = target('composer')
    else if (effect.target.kind === 'composer') effect.target = target('object')
  })
</script>

{#snippet conditionFields(value: GuideCondition, update: (value: GuideCondition) => void)}
  <label>Condition <select value={value.kind} onchange={event => update(condition(event.currentTarget.value as GuideCondition['kind']))}><option value="clock">Simulation clock</option><option value="object-status">Object status</option><option value="observation">Observed value</option></select></label>
  {#if value.kind === 'clock'}
    <p class="hint">Bounds are simulation seconds after Run start. Supply at least one; both must be in order.</p>
    <div class="row">
      <label>At or after (seconds) <input type="number" min="0" value={value.afterSeconds ?? ''} oninput={event => update({ ...value, afterSeconds: event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber })} /></label>
      <label>At or before (seconds) <input type="number" min="0" value={value.beforeSeconds ?? ''} oninput={event => update({ ...value, beforeSeconds: event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber })} /></label>
    </div>
  {:else if value.kind === 'object-status'}
    <label>Object id <input list="guide-authored-objects" value={value.objectId} oninput={event => update({ ...value, objectId: event.currentTarget.value as ObjectId })} /></label>
    <label>Exact operational status <input value={value.status} oninput={event => update({ ...value, status: event.currentTarget.value })} /></label>
  {:else}
    <p class="hint">Use an exact observable ref (objectId#signal), quantity and unit from World observation discovery. Missing, stale or refused evidence cannot complete a step.</p>
    <label>Observable ref <input value={value.ref} oninput={event => update({ ...value, ref: event.currentTarget.value })} /></label>
    <div class="row">
      <label>Quantity <select value={value.quantity} onchange={event => { const quantity = event.currentTarget.value as Quantity; update({ ...value, quantity, unit: quantityUnits[quantity][0] }) }}>{#each Object.keys(quantityUnits) as quantity}<option value={quantity}>{quantity}</option>{/each}</select></label>
      <label>Unit <select value={value.unit} onchange={event => update({ ...value, unit: event.currentTarget.value })}>{#each quantityUnits[value.quantity] as unit}<option value={unit}>{unit || 'No unit (state)'}</option>{/each}</select></label>
    </div>
    <div class="row">
      <label>Value type <select value={typeof value.value} onchange={event => update({ ...value, operator: 'eq', value: event.currentTarget.value === 'boolean' ? true : event.currentTarget.value === 'number' ? 0 : '' })}><option value="number">Number</option><option value="boolean">Boolean</option><option value="string">Text</option></select></label>
      <label>Comparison <select value={value.operator} onchange={event => update({ ...value, operator: event.currentTarget.value as typeof value.operator })}><option value="eq">Equals</option>{#if typeof value.value === 'number'}<option value="lt">Less than</option><option value="lte">At most</option><option value="gt">Greater than</option><option value="gte">At least</option>{/if}</select></label>
    </div>
    {#if typeof value.value === 'boolean'}<label>Expected value <select value={String(value.value)} onchange={event => update({ ...value, value: event.currentTarget.value === 'true' })}><option value="true">True</option><option value="false">False</option></select></label>
    {:else if typeof value.value === 'number'}<label>Expected value <input type="number" value={value.value} oninput={event => update({ ...value, value: event.currentTarget.valueAsNumber })} /></label>
    {:else}<label>Expected value <input value={value.value} oninput={event => update({ ...value, value: event.currentTarget.value })} /></label>{/if}
    <label>Maximum evidence age (seconds) <input type="number" min="0.001" step="any" value={value.maxAgeSeconds} oninput={event => update({ ...value, maxAgeSeconds: event.currentTarget.valueAsNumber })} /></label>
  {/if}
{/snippet}

<section class="guide-editor" aria-label="Scenario guide editor">
  <h3>Guide and tutorial</h3>
  <p>Guide steps explain what matters, draw attention and wait for a person or real evidence. Timeline events remain separate simulation actions.</p>
  <datalist id="guide-authored-objects">{#each objects as object}<option value={object.id}>{object.label}</option>{/each}</datalist>
  <datalist id="guide-pack-panels">{#each panelChoices as panel}<option value={panel.id}>{panel.label}</option>{/each}</datalist>
  {#if working === undefined}
    <button type="button" onclick={addGuide}>Add guide</button>
  {:else}
    <label>Guide title <input value={working.title} maxlength="120" oninput={event => edit(candidate => { candidate.title = event.currentTarget.value })} /></label>
    <label>Description <textarea rows="2" value={working.description ?? ''} oninput={event => edit(candidate => { candidate.description = event.currentTarget.value || undefined })}></textarea></label>
    <label class="check"><input type="checkbox" checked={working.startPaused} onchange={event => edit(candidate => { candidate.startPaused = event.currentTarget.checked })} /> Start the simulation clock paused</label>
    <details><summary>Entry condition</summary><p class="hint">Optional evidence required to start this guide, including a copied Run.</p>
      {#if working.entry}{@render conditionFields(working.entry, value => edit(candidate => { candidate.entry = value }))}<button type="button" onclick={() => edit(candidate => { delete candidate.entry })}>Remove entry condition</button>
      {:else}<button type="button" onclick={() => edit(candidate => { candidate.entry = condition('clock') })}>Add entry condition</button>{/if}
    </details>
    {#each working.steps as current, index (index)}
      <details class="step" open={index === 0 || current.id === expandedStepId}>
        <summary>{index + 1}. {current.title || 'Untitled step'}</summary>
        <div class="toolbar"><button type="button" disabled={index === 0} onclick={() => move(index, -1)}>Move up</button><button type="button" disabled={index === working!.steps.length - 1} onclick={() => move(index, 1)}>Move down</button><button type="button" onclick={() => edit(candidate => { candidate.steps.splice(index, 1) })}>Remove step</button></div>
        <label>Step title <input value={current.title} maxlength="120" oninput={event => step(index, value => { value.title = event.currentTarget.value })} /></label>
        <label>Instruction <textarea rows="3" maxlength="2000" value={current.instruction} oninput={event => step(index, value => { value.instruction = event.currentTarget.value })}></textarea></label>
        <label>Help (optional) <textarea rows="2" maxlength="2000" value={current.help ?? ''} oninput={event => step(index, value => { value.help = event.currentTarget.value || undefined })}></textarea></label>
        <details><summary>Step identity, roles and next step</summary>
          <label>Stable step id <input value={current.id} oninput={event => step(index, value => { value.id = event.currentTarget.value })} /></label>
          <label>Eligible role ids (one per line; empty is public) <textarea rows="2" value={current.roles?.join('\n') ?? ''} onchange={event => step(index, value => { const roles = event.currentTarget.value.split('\n').map(id => id.trim()).filter(Boolean); value.roles = roles.length ? roles : undefined })}></textarea></label>
          <label>Next step <select value={current.next ?? ''} onchange={event => step(index, value => { value.next = event.currentTarget.value || undefined })}><option value="">Next eligible step in this order</option>{#if current.next && !working.steps.slice(index + 1).some(value => value.id === current.next)}<option value={current.next}>{current.next} (must name a later step)</option>{/if}{#each working.steps.slice(index + 1) as later}<option value={later.id}>{later.title} · {later.id}</option>{/each}</select></label>
        </details>
        <h4>Attention and presentation</h4>
        <p class="hint">Each action has its own delivery result. Prompt suggestions require the person to submit; they never auto-send.</p>
        {#each current.effects as effect, effectIndex (effectIndex)}
          <fieldset><legend>Action {effectIndex + 1}</legend>
            <details><summary>Stable action identity</summary><label>Action id <input value={effect.id} oninput={event => step(index, value => { value.effects[effectIndex]!.id = event.currentTarget.value })} /></label></details>
            <div class="row"><label>Target <select value={effect.target.kind} onchange={event => setTargetKind(index, effectIndex, event.currentTarget.value as GuideTarget['kind'])}><option value="object">Object / display</option><option value="panel">Pack panel</option><option value="control">View control</option><option value="composer">Assistant composer</option></select></label>
              <label>Action <select value={effect.action.kind} onchange={event => setActionKind(index, effectIndex, event.currentTarget.value as Exclude<PresentationAction['kind'], 'clear'>)}>{#if !actionChoices(effect.target).includes(effect.action.kind as Exclude<PresentationAction['kind'], 'clear'>)}<option value={effect.action.kind}>{effect.action.kind} (unlisted for this target)</option>{/if}{#each actionChoices(effect.target) as kind}<option value={kind}>{actionLabels[kind]}</option>{/each}</select></label></div>
            {#if effect.target.kind === 'object'}
              <label>Object id <input list="guide-authored-objects" value={effect.target.objectId} oninput={event => step(index, value => { const target = value.effects[effectIndex]!.target; if (target.kind === 'object') target.objectId = event.currentTarget.value as ObjectId })} /></label>
              <label>Element id (optional) <input value={effect.target.elementId ?? ''} oninput={event => step(index, value => { const target = value.effects[effectIndex]!.target; if (target.kind === 'object') target.elementId = event.currentTarget.value || undefined })} /></label>
              <label class="check"><input type="checkbox" checked={effect.target.lateBound === true} onchange={event => step(index, value => { const target = value.effects[effectIndex]!.target; if (target.kind === 'object') target.lateBound = event.currentTarget.checked ? true : undefined })} /> Object is created later by the timeline</label>
            {:else if effect.target.kind === 'panel'}
              <label>Panel id <input list="guide-pack-panels" value={effect.target.panelId} oninput={event => step(index, value => { const target = value.effects[effectIndex]!.target; if (target.kind === 'panel') target.panelId = event.currentTarget.value })} /></label>
              <button type="button" disabled={panelsLoading} onclick={() => void loadPanels()}>{panelsLoading ? 'Loading panel choices…' : 'Load selected Pack panel choices'}</button>
            {:else if effect.target.kind === 'control'}
              {@const controlTarget = effect.target}
              <label>View control <select value={controlTarget.controlId} onchange={event => step(index, value => { const target = value.effects[effectIndex]!.target; if (target.kind === 'control') target.controlId = event.currentTarget.value })}>{#if !guideControlTargets.some(control => control.id === controlTarget.controlId)}<option value={controlTarget.controlId}>{controlTarget.controlId} (unlisted)</option>{/if}{#each guideControlTargets as control}<option value={control.id}>{control.label}</option>{/each}</select></label>
            {/if}
            {#if effect.action.kind === 'focus'}<label>Map zoom (optional, 0–24) <input type="number" min="0" max="24" step="any" value={effect.action.zoom ?? ''} oninput={event => step(index, value => { const action = value.effects[effectIndex]!.action; if (action.kind === 'focus') action.zoom = event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber })} /></label>
            {:else if effect.action.kind === 'explain'}
              <label>Callout title <input value={effect.action.title} maxlength="120" oninput={event => step(index, value => { const action = value.effects[effectIndex]!.action; if (action.kind === 'explain') action.title = event.currentTarget.value })} /></label>
              <label>Explanation <textarea rows="3" value={effect.action.text} maxlength="2000" oninput={event => step(index, value => { const action = value.effects[effectIndex]!.action; if (action.kind === 'explain') action.text = event.currentTarget.value })}></textarea></label>
            {:else if effect.action.kind === 'draft'}<label>Suggested prompt <textarea rows="3" maxlength="8000" value={effect.action.text} oninput={event => step(index, value => { const action = value.effects[effectIndex]!.action; if (action.kind === 'draft') action.text = event.currentTarget.value })}></textarea></label>{/if}
            <button type="button" onclick={() => step(index, value => { value.effects.splice(effectIndex, 1) })}>Remove action</button>
          </fieldset>
        {/each}
        <button type="button" onclick={() => step(index, value => { value.effects.push({ id: `effect-${crypto.randomUUID()}`, target: target('object'), action: { kind: 'highlight' } }) })}>Add attention action</button>
        <h4>Complete this step when</h4>
        <label>Completion <select value={current.completion.kind} onchange={event => setCompletion(index, event.currentTarget.value as GuideStep['completion']['kind'])}><option value="acknowledge">Person chooses Next</option><option value="presentation">An attention action is applied</option><option value="prompt-response">Offered prompt has a completed Assistant response</option><option value="condition">A typed World condition is satisfied</option></select></label>
        {#if current.completion.kind === 'condition'}{@render conditionFields(current.completion.condition, value => step(index, current => { current.completion = { kind: 'condition', condition: value } }))}
        {:else if current.completion.kind === 'presentation' || current.completion.kind === 'prompt-response'}
          {@const completion = current.completion}
          <label>Required action <select value={completion.effectId} onchange={event => step(index, value => { value.completion = { kind: completion.kind, effectId: event.currentTarget.value } })}><option value="">Choose an action</option>{#each current.effects.filter(effect => completion.kind !== 'prompt-response' || effect.action.kind === 'draft') as effect}<option value={effect.id}>Action {current.effects.indexOf(effect) + 1}: {effect.action.kind}</option>{/each}</select></label>
          {#if current.completion.kind === 'prompt-response'}<p class="hint">Requires actual Agents submission and a completed response. Applying a suggestion, text matching or an error response cannot satisfy it.</p>{/if}
        {/if}
      </details>
    {/each}
    <div class="toolbar"><button type="button" onclick={addStep}>Add step</button>
      <AdvancedConfiguration label="Guide JSON" value={working} onapply={async value => { const parsed = guideDefinitionSchema.safeParse(value); if (!parsed.success) throw new Error(issues(parsed.error).join('\n')); commit(parsed.data) }} />
      <button type="button" onclick={() => commit(undefined)}>Remove guide</button></div>
    <p class="hint">Advanced JSON preserves entry conditions, roles, exact references and explicit next-step links. The whole Guide is validated before it enters the Scenario draft.</p>
  {/if}
  {#if panelError}<p role="alert">Panel choices could not load: {panelError}</p>{/if}
  {#if errors.length}<div role="alert"><strong>Guide changes are not applied. Fix these fields before saving:</strong><ul>{#each errors as error}<li>{error}</li>{/each}</ul><button type="button" onclick={() => { working = guide === undefined ? undefined : copy(guide); errors = []; oninvalid(false) }}>Discard unvalidated Guide changes</button></div>{/if}
</section>

<style>
  .guide-editor { margin-block: 16px; }
  .guide-editor > p, .hint { font-size: 13px; line-height: 1.5; opacity: .8; }
  .step, fieldset, details { min-width: 0; border: 1px solid var(--border, #425670); border-radius: 6px; padding: 10px; margin-block: 10px; }
  summary { cursor: pointer; font-weight: 600; overflow-wrap: anywhere; }
  label { display: block; margin-block: 8px; font-size: 13px; }
  input:not([type=checkbox]), select, textarea { display: block; box-sizing: border-box; width: 100%; margin-top: 4px; font: inherit; color: inherit; background: var(--input-bg, #09131f); border: 1px solid var(--border, #425670); border-radius: 4px; padding: 7px; }
  textarea { resize: vertical; }
  .check { display: flex; align-items: start; gap: 8px; }
  .row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .toolbar { display: flex; gap: 6px; flex-wrap: wrap; margin-block: 10px; }
  button { cursor: pointer; }
  button:disabled { cursor: default; opacity: .5; }
  [role=alert] { border: 1px solid currentColor; border-radius: 6px; padding: 10px; overflow-wrap: anywhere; }
  @media (max-width: 500px) { .row { grid-template-columns: 1fr; gap: 0; } }
  @media (pointer: coarse) {
    .guide-editor :global(button), input:not([type=checkbox]), select, summary, .check { min-height: 44px; }
    summary, .check { align-content: center; }
  }
</style>
