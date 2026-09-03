<script lang="ts">
  import type { OperationalObject, SimulationRunId } from '../../../core/model/index.ts'
  import { scenarioAuthoringCatalogSchema } from '../../../core/scenarios/authoring.ts'
  import AuthoringFields from '../../../ui/AuthoringFields.svelte'
  import { deepCopy, setValueAtPath, valueAtPath, type AuthoringField, type AuthoringItemType } from '../../../ui/scenario-builder-model.ts'
  import type { MapView } from '../../../ui/map-view.ts'
  import { runOnMount } from '../../../ui/svelte-lifecycle.svelte.ts'
  import { invokeWorld } from '../../../ui/workspace-capability-client.ts'
  import { ambulanceDataOf, ambulancePackId } from '../model.ts'

  const { simulationRunId, objects, mapView, onCreated }: {
    simulationRunId: SimulationRunId
    objects: ReadonlyArray<OperationalObject>
    mapView: MapView | null
    onCreated: () => void
  } = $props()
  let types = $state<AuthoringItemType[]>([])
  let typeId = $state('')
  let draft = $state<Record<string, unknown>>({})
  let longitude = $state<number | undefined>()
  let latitude = $state<number | undefined>()
  let error = $state('')
  let creating = $state(false)
  const selectedType = $derived(types.find(type => type.id === typeId))
  const items = $derived(objects.map(object => ({ id: object.id, label: object.label, type: object.packId === ambulancePackId ? ambulanceDataOf(object).type : object.kind })))
  const hasReference = $derived(!!(selectedType?.placement?.orReference && valueAtPath(draft, selectedType.placement.orReference)))
  const validPoint = $derived(longitude !== undefined && latitude !== undefined && Number.isFinite(longitude) && Number.isFinite(latitude) && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90)
  const canCreate = $derived(!!selectedType && !!String(draft.label ?? '').trim()
    && (!selectedType.placement || hasReference || validPoint)
    && selectedType.fields.every(field => field.control.kind !== 'reference' || field.optional || !!valueAtPath(draft, field.path)))

  function selectType(id: string) {
    const type = types.find(candidate => candidate.id === id)
    if (!type) throw new Error('Unknown Ambulance authoring item type: ' + id)
    typeId = id
    draft = { ...deepCopy(type.defaultItem), label: type.label }
    longitude = undefined; latitude = undefined; error = ''
  }
  function change(field: AuthoringField, value: unknown) {
    setValueAtPath(draft, field.path, value)
    if (selectedType?.placement?.orReference?.join('.') === field.path.join('.') && value) {
      setValueAtPath(draft, selectedType.placement.path, undefined)
      longitude = undefined; latitude = undefined
    }
  }
  function placeFromMap() {
    if (!mapView || !selectedType?.placement) return
    longitude = mapView.center[0]; latitude = mapView.center[1]
    if (selectedType.placement.orReference) setValueAtPath(draft, selectedType.placement.orReference, undefined)
  }
  async function create() {
    if (!selectedType || !canCreate || creating) return
    creating = true; error = ''
    try {
      const item = { ...deepCopy(draft), type: selectedType.id, id: selectedType.idPrefix + '-' + crypto.randomUUID() }
      if (selectedType.placement && !hasReference) setValueAtPath(item, selectedType.placement.path, [longitude, latitude])
      await invokeWorld('world.ambulance.create-item', { item }, { simulationRunId })
      selectType(typeId)
      onCreated()
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    finally { creating = false }
  }
  runOnMount(() => {
    let active = true
    void invokeWorld('world.scenario-authoring.describe', {}).then(scenarioAuthoringCatalogSchema.parse).then(catalog => {
      if (!active) return
      const pack = catalog.packs.find(candidate => candidate.id === 'ambulance')
      if (!pack?.itemTypes.length) throw new Error('Ambulance authoring is unavailable')
      types = pack.itemTypes
      selectType(types[0]!.id)
    }).catch(cause => { if (active) error = String(cause) })
    return () => { active = false }
  })
</script>

<section aria-label="Create ambulance scenario item">
  <h3>Create an item</h3>
  <p>Uses the same configuration as the Scenario editor. New items belong to this Run.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if selectedType}
    <form onsubmit={event => { event.preventDefault(); void create() }}>
      <label>Item type<select value={typeId} onchange={event => selectType(event.currentTarget.value)}>{#each types as type}<option value={type.id}>{type.label}</option>{/each}</select></label>
      <p>{selectedType.description}</p>
      <label>Name<input value={String(draft.label ?? '')} oninput={event => draft.label = event.currentTarget.value} required /></label>
      <AuthoringFields fields={selectedType.fields} targetFor={() => draft} {items} onchange={change} />
      {#if selectedType.placement}
        <fieldset><legend>Location</legend>
          {#if hasReference}<p>Location comes from the selected asset. Remove that reference to enter coordinates.</p>{:else}
            <div class="coordinates"><label>Longitude<input type="number" min="-180" max="180" step="any" bind:value={longitude} /></label><label>Latitude<input type="number" min="-90" max="90" step="any" bind:value={latitude} /></label></div>
          {/if}
          <button type="button" onclick={placeFromMap} disabled={!mapView}>Use map centre</button>
        </fieldset>
      {/if}
      <button type="submit" disabled={!canCreate || creating}>{creating ? 'Creating…' : 'Create ' + selectedType.label.toLowerCase()}</button>
    </form>
  {:else}<p>Loading item configuration…</p>{/if}
</section>

<style>
  section{font-size:13px}h3{margin:0 0 10px}p{color:var(--muted,#94a3b8)}form{display:grid;gap:10px}label{display:grid;gap:4px}.coordinates{display:flex;gap:8px}.coordinates label{min-width:0;flex:1}input,select,button{box-sizing:border-box;width:100%;padding:8px;background:var(--panel,#182333);color:inherit;border:1px solid #64748b88;border-radius:5px}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}fieldset{border:1px solid #64748b66;padding:10px}fieldset button{margin-top:8px}[role=alert]{color:#f87171;white-space:pre-wrap}
</style>
