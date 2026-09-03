<script lang="ts">
  import type { OperationalObject, SimulationRunId } from '../../../core/model/index.ts'
  import type { MapView } from '../../../ui/map-view.ts'
  import { runOnMount } from '../../../ui/svelte-lifecycle.svelte.ts'
  import { invokeWorld } from '../../../ui/workspace-capability-client.ts'
  import { ambulanceDataOf, ambulancePackId, ambulancePackDataSchema, assignmentWarnings, cancelEligibility, careSitePackDataSchema, noTransportEligibility, patientPackDataSchema, returnToBaseEligibility, urgencySchema, type Urgency } from '../model.ts'
  import { ambulanceMetricsSchema, dispatchOptionsSchema, dispatchStateSchema, type AmbulanceMetrics, type DispatchOptions, type DispatchState } from '../query.ts'
  import CreateItemPanel from './CreateItemPanel.svelte'

  const { simulationRunId, objects, mapView = null, onClose, onFocusMap = () => {} }: {
    simulationRunId: SimulationRunId
    objects: ReadonlyArray<OperationalObject>
    mapView?: MapView | null
    onClose: () => void
    onFocusMap?: (target: { kind: 'point'; center: readonly [number, number] }) => void
  } = $props()
  let tab = $state<'dispatch' | 'units' | 'patients' | 'sites' | 'metrics' | 'create'>('dispatch')
  let snapshot = $state<DispatchState | null>(null)
  let metrics = $state<AmbulanceMetrics | null>(null)
  let dispatchOptions = $state<DispatchOptions | null>(null)
  let transportOptions = $state<DispatchOptions | null>(null)
  let incidentId = $state(''), unitId = $state(''), patientId = $state(''), siteId = $state(''), destinationId = $state('')
  let patientIds = $state<string[]>([])
  let assessment = $state<Urgency>('urgent'), needs = $state(''), dispositionReason = $state('')
  let patientRevision = $state<number>(), siteRevision = $state<number>()
  let optionOffset = $state(0), siteOffset = $state(0)
  let siteAccepting = $state(true), siteSlots = $state(1), siteSeconds = $state(900), siteCapabilities = $state(''), siteUrgencies = $state('')
  let error = $state(''), refreshError = $state(''), notice = $state(''), busy = $state(false), loading = $state(false)
  let sequence = 0, optionSequence = 0, disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const domainObjects = $derived(objects.filter(object => object.packId === ambulancePackId))
  const incidents = $derived(domainObjects.filter(object => ambulanceDataOf(object).type === 'incident'))
  const units = $derived(domainObjects.filter(object => ambulanceDataOf(object).type === 'ambulance'))
  const patients = $derived(domainObjects.filter(object => ambulanceDataOf(object).type === 'patient'))
  const sites = $derived(domainObjects.filter(object => ambulanceDataOf(object).type === 'care-site'))
  const incidentPatients = $derived(patients.filter(object => patientPackDataSchema.parse(object.packData).incidentId === incidentId))
  const selectedUnit = $derived(units.find(object => object.id === unitId))
  const selectedUnitData = $derived(selectedUnit ? ambulancePackDataSchema.parse(selectedUnit.packData) : null)
  const selectedPatient = $derived(patients.find(object => object.id === patientId))
  const selectedPatientData = $derived(selectedPatient ? patientPackDataSchema.parse(selectedPatient.packData) : null)
  const selectedSite = $derived(sites.find(object => object.id === siteId))
  const cancelReasons = $derived(selectedUnit ? cancelEligibility(selectedUnit) : ['Select a unit'])
  const returnReasons = $derived(selectedUnit ? returnToBaseEligibility(selectedUnit, objects) : ['Select a unit'])
  const unitWarnings = $derived(selectedUnit ? assignmentWarnings(selectedUnit, objects) : [])
  const noTransportReasons = $derived(noTransportEligibility(selectedPatient, objects))
  const metricRows = $derived(metrics ? [
    { label: 'First incident response', value: metrics.incidents.firstResponse },
    { label: 'Dispatch wait', value: metrics.patients.dispatchWait },
    { label: 'Mobilization', value: metrics.patients.mobilization },
    { label: 'Patient contact', value: metrics.patients.timeToContact },
    { label: 'Pickup to receiving-site arrival', value: metrics.patients.transport },
    { label: 'Receiving-site handover queue', value: metrics.patients.handoverWait },
    { label: 'Handover', value: metrics.patients.handover },
  ] : [])
  const lines = (value: string) => value.split('\n').map(part => part.trim()).filter(Boolean)
  const labelFor = (id: string) => objects.find(object => object.id === id)?.label ?? id
  const seconds = (value: number | null | undefined) => value === null || value === undefined ? '—' : Math.max(0, Math.ceil(value)) + ' s'

  function focus(id: string) {
    const object = objects.find(object => object.id === id)
    if (!object) return
    const data = object.packId === ambulancePackId ? ambulanceDataOf(object) : null
    const holder = data?.type === 'patient' ? objects.find(candidate => candidate.id === data.holder.id) : object
    const point = holder?.spatial.position?.point
    if (point) onFocusMap({ kind: 'point', center: point.coordinates })
  }
  async function refreshOptions() {
    const request = ++optionSequence
    try {
      const [nextDispatch, nextTransport] = await Promise.all([
        tab === 'dispatch' && incidentId && patientIds.length ? invokeWorld('world.ambulance.dispatch-options', { action: 'dispatch', incidentId, patientIds, limit: 100, offset: optionOffset }, { simulationRunId }).then(dispatchOptionsSchema.parse) : Promise.resolve(null),
        tab === 'units' && unitId ? invokeWorld('world.ambulance.dispatch-options', { action: 'transport', ambulanceId: unitId, limit: 100, offset: optionOffset }, { simulationRunId }).then(dispatchOptionsSchema.parse) : Promise.resolve(null),
      ])
      if (disposed || request !== optionSequence) return
      dispatchOptions = nextDispatch; transportOptions = nextTransport
      refreshError = ''
    } catch (cause) { if (!disposed && request === optionSequence) { dispatchOptions = null; transportOptions = null; refreshError = String(cause) } }
  }
  async function refresh() {
    const request = ++sequence
    loading = true
    try {
      const next = dispatchStateSchema.parse(await invokeWorld('world.ambulance.dispatch-state', { limit: 100, offset: tab === 'sites' ? siteOffset : 0 }, { simulationRunId }))
      if (disposed || request !== sequence) return
      snapshot = next
      if (!incidentId) incidentId = next.incidents.find(incident => incident.closedAtMs === null)?.id ?? ''
      const existing = new Set(domainObjects.map(object => String(object.id)))
      patientIds = patientIds.filter(id => existing.has(id))
      if (unitId && !existing.has(unitId)) unitId = ''
      if (patientId && !existing.has(patientId)) patientId = ''
      if (siteId && !existing.has(siteId)) siteId = ''
      if (incidentId && !existing.has(incidentId)) { incidentId = ''; patientIds = [] }
      if (tab === 'metrics') {
        const nextMetrics = ambulanceMetricsSchema.parse(await invokeWorld('world.ambulance.metrics', {}, { simulationRunId }))
        if (!disposed && request === sequence) metrics = nextMetrics
      }
      await refreshOptions()
    } catch (cause) { if (!disposed && request === sequence) refreshError = String(cause) }
    finally { if (!disposed && request === sequence) loading = false }
  }
  async function command(id: string, input: unknown, expectedRevision?: number) {
    if (busy) return
    const editingPatient = patientId, editingSite = siteId
    busy = true; error = ''; notice = ''
    try {
      await invokeWorld('world.ambulance.' + id, input, { simulationRunId, ...(expectedRevision === undefined ? {} : { expectedRevision }) })
      notice = 'Command accepted. Shared simulation state will reflect the change.'
      await refresh()
      if (id === 'set-patient-assessment' || id === 'set-patient-disposition') {
        const { object } = await invokeWorld<{ object: OperationalObject | null }>('world.ambulance.object', { objectId: editingPatient }, { simulationRunId })
        if (object && patientId === editingPatient) selectPatient(editingPatient, object)
      }
      if (id === 'set-care-site') {
        const { object } = await invokeWorld<{ object: OperationalObject | null }>('world.ambulance.object', { objectId: editingSite }, { simulationRunId })
        if (object && siteId === editingSite) selectSite(editingSite, object)
      }
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    finally { busy = false }
  }
  function selectIncident(id: string) { incidentId = id; patientIds = []; destinationId = ''; optionOffset = 0; dispatchOptions = null }
  function selectPatient(id: string, current?: OperationalObject) {
    patientId = id; dispositionReason = ''
    const object = current ?? patients.find(object => object.id === id)
    patientRevision = object?.revision
    if (object) { const data = patientPackDataSchema.parse(object.packData); assessment = data.assessedUrgency; needs = data.needs.join('\n') }
  }
  function selectSite(id: string, current?: OperationalObject) {
    siteId = id
    const object = current ?? sites.find(object => object.id === id)
    siteRevision = object?.revision
    if (object) { const data = careSitePackDataSchema.parse(object.packData); siteAccepting = data.accepting; siteSlots = data.handoverSlots; siteSeconds = data.handoverSeconds; siteCapabilities = data.capabilities.join('\n'); siteUrgencies = data.acceptedUrgencies.join('\n') }
  }
  function setTab(value: typeof tab) { tab = value; error = ''; optionOffset = 0; void refresh() }
  runOnMount(() => {
    disposed = false
    const poll = async () => { await refresh(); if (!disposed) timer = setTimeout(poll, 1000) }
    void poll()
    return () => { disposed = true; sequence++; optionSequence++; clearTimeout(timer) }
  })
</script>

<section class="dispatch-panel" aria-label="Ambulance dispatch">
  <header><div><strong>Ambulance dispatch</strong><small>{snapshot ? new Date(snapshot.simulationTimeMs).toLocaleTimeString() + ' · simulation time' : 'Connecting…'}</small></div><button aria-label="Close dispatch panel" onclick={onClose}>×</button></header>
  <nav>{#each [['dispatch','Dispatch'],['units','Units'],['patients','Patients'],['sites','Care sites'],['metrics','Measures'],['create','Create']] as [id,label]}<button class:active={tab === id} onclick={() => setTab(id as typeof tab)}>{label}</button>{/each}</nav>
  <div class="body">
    {#if error}<p role="alert">{error}</p>{/if}{#if refreshError}<p role="alert">Refresh failed: {refreshError}. Displayed state may be stale.</p>{/if}{#if notice}<p role="status">{notice}</p>{/if}
    {#if tab === 'dispatch'}
      <label>Incident<select value={incidentId} onchange={event => selectIncident(event.currentTarget.value)}><option value="">Select an incident</option>{#each incidents as incident}<option value={incident.id}>{incident.label} · {incident.operational.status}</option>{/each}</select></label>
      {#if incidentId}<button onclick={() => focus(incidentId)}>Show incident on map</button>{/if}
      <h3>Patients to assign</h3><p>Select an explicit patient group. Dispatch does not invent or automatically reveal patients.</p>
      {#each incidentPatients as patient}
        {@const data = patientPackDataSchema.parse(patient.packData)}
        <label class="patient-choice"><input type="checkbox" checked={patientIds.includes(patient.id)} disabled={data.disposition !== 'active' || data.holder.kind !== 'incident' || busy} onchange={event => { patientIds = event.currentTarget.checked ? [...patientIds, patient.id] : patientIds.filter(id => id !== patient.id); optionOffset = 0; void refreshOptions() }} /><span>{patient.label}<small>{data.assessedUrgency} · {data.disposition} · needs: {data.needs.join(', ') || 'None configured'}</small></span></label>
      {/each}
      {#if !incidentPatients.length}<p>No patient items at this incident. Use Create to add explicitly described patients.</p>{/if}
      {#if dispatchOptions}
        <label>Optional onward care destination<select bind:value={destinationId}><option value="">Choose after scene service</option>{#each dispatchOptions.careSites as site}<option value={site.id} disabled={!site.eligible}>{site.label}{site.eligible ? '' : ' · ' + site.reasons.join('; ')}</option>{/each}</select></label>
        <h3>Response units</h3>
        {#each dispatchOptions.units as unit}<article><strong>{unit.label}</strong>{#if unit.reasons.length}<p>{unit.reasons.join(' · ')}</p>{/if}<button disabled={busy || !unit.eligible} onclick={() => command('dispatch', { ambulanceId: unit.id, incidentId, patientIds, ...(destinationId ? { destinationId } : {}) })}>Dispatch selected patients</button></article>{/each}
        {#if optionOffset || dispatchOptions.truncated}<div class="row"><button disabled={!optionOffset} onclick={() => { optionOffset = Math.max(0, optionOffset - 100); void refreshOptions() }}>Previous candidates</button><button disabled={!dispatchOptions.truncated} onclick={() => { optionOffset += 100; void refreshOptions() }}>Next candidates</button></div>{/if}
      {:else if patientIds.length && !error}<p>Checking available resources…</p>{/if}
    {:else if tab === 'units'}
      <label>Response unit<select value={unitId} onchange={event => { unitId = event.currentTarget.value; optionOffset = 0; void refreshOptions() }}><option value="">Select a unit</option>{#each units as unit}<option value={unit.id}>{unit.label} · {unit.operational.status}</option>{/each}</select></label>
      {#if selectedUnit && selectedUnitData}
        <h3>{selectedUnit.label}</h3><p>{selectedUnitData.assignment?.phase ?? 'Unassigned'} · capacity {selectedUnitData.patientCapacity}</p>
        <p>Assigned patients: {(selectedUnitData.assignment?.patientIds ?? []).map(labelFor).join(', ') || 'None'}</p>
        {#if selectedUnitData.assignment?.phaseDueAtMs !== undefined && snapshot}<p>Phase remaining: {seconds((selectedUnitData.assignment.phaseDueAtMs - snapshot.simulationTimeMs) / 1000)}</p>{/if}
        {#if selectedUnit.spatial.route}<p>Route remaining: {seconds(selectedUnit.spatial.route.etaSeconds)} (current conditions)</p>{/if}
        {#each unitWarnings as warning}<p class="warning">{warning}</p>{/each}
        <button onclick={() => focus(unitId)}>Show unit on map</button>
        <label class="check"><input type="checkbox" checked={selectedUnitData.crewReady} disabled={busy} onchange={event => command('set-unit-readiness', { ambulanceId: unitId, ready: event.currentTarget.checked })} />Crew ready</label>
        <div class="row"><button disabled={busy || cancelReasons.length > 0} title={cancelReasons.join('; ')} onclick={() => command('cancel', { ambulanceId: unitId })}>Cancel / hold</button><button disabled={busy || returnReasons.length > 0} title={returnReasons.join('; ')} onclick={() => command('return-to-base', { ambulanceId: unitId })}>Return to base</button></div>
        {#if cancelReasons.length}<small>Cancel: {cancelReasons.join('; ')}</small>{/if}{#if returnReasons.length}<small>Return: {returnReasons.join('; ')}</small>{/if}
        <h3>Transport destination</h3>{#each transportOptions?.careSites ?? [] as site}<article><strong>{site.label}</strong>{#if site.reasons.length}<p>{site.reasons.join(' · ')}</p>{/if}<button disabled={busy || !site.eligible} onclick={() => command('transport', { ambulanceId: unitId, destinationId: site.id })}>Transport / redirect here</button></article>{/each}
        {#if optionOffset || transportOptions?.truncated}<div class="row"><button disabled={!optionOffset} onclick={() => { optionOffset = Math.max(0, optionOffset - 100); void refreshOptions() }}>Previous destinations</button><button disabled={!transportOptions?.truncated} onclick={() => { optionOffset += 100; void refreshOptions() }}>Next destinations</button></div>{/if}
      {/if}
    {:else if tab === 'patients'}
      <label>Patient<select value={patientId} onchange={event => selectPatient(event.currentTarget.value)}><option value="">Select a patient</option>{#each patients as patient}<option value={patient.id}>{patient.label}</option>{/each}</select></label>
      {#if selectedPatientData}
        <p>{selectedPatientData.summary}</p><p>{selectedPatientData.disposition} · currently with {labelFor(selectedPatientData.holder.id)}</p><button onclick={() => focus(patientId)}>Show current location</button>
        <label>Assessed urgency<select bind:value={assessment}>{#each urgencySchema.options as urgency}<option value={urgency}>{urgency}</option>{/each}</select></label>
        <label>Required care capability tags<textarea rows="3" bind:value={needs}></textarea></label>
        {#if selectedPatient?.revision !== patientRevision}<p class="warning">This patient changed since you opened the form. Your edits are preserved.</p><button onclick={() => selectPatient(patientId)}>Reload current values</button>{/if}
        <button disabled={busy || selectedPatientData.disposition !== 'active'} onclick={() => command('set-patient-assessment', { patientId, assessedUrgency: assessment, needs: lines(needs) }, patientRevision)}>Save assessment</button>
        <h3>No transport</h3><label>Reason<textarea rows="2" bind:value={dispositionReason} placeholder="Document the operational decision; not clinical advice"></textarea></label>
        <button disabled={busy || noTransportReasons.length > 0 || !dispositionReason.trim()} title={noTransportReasons.join('; ')} onclick={() => command('set-patient-disposition', { patientId, disposition: 'no-transport', reason: dispositionReason.trim() }, patientRevision)}>Record no-transport disposition</button>
        {#if noTransportReasons.length}<small>{noTransportReasons.join('; ')}</small>{/if}
        {#if selectedPatientData.dispositionReason}<p>{selectedPatientData.dispositionReason}</p>{/if}
      {/if}
    {:else if tab === 'sites'}
      <h3>Queues and handovers</h3>{#each snapshot?.careSites ?? [] as site}<article><strong>{site.label}</strong><p>{site.handingOverUnitIds.length}/{site.handoverSlots} slots occupied · {site.queuedUnitIds.length} queued</p>{#if site.queuedUnitIds.length}<small>Queue: {site.queuedUnitIds.map(labelFor).join(', ')}</small>{/if}{#if site.handingOverUnitIds.length}<small>Handing over: {site.handingOverUnitIds.map(labelFor).join(', ')}</small>{/if}<button onclick={() => { selectSite(site.id); focus(site.id) }}>Inspect / configure</button></article>{/each}
      <label>Care site<select value={siteId} onchange={event => selectSite(event.currentTarget.value)}><option value="">Select a care site</option>{#each sites as site}<option value={site.id}>{site.label}</option>{/each}</select></label>
      {#if siteOffset || (snapshot && siteOffset + 100 < snapshot.totals.careSites)}<div class="row"><button disabled={!siteOffset} onclick={() => { siteOffset = Math.max(0, siteOffset - 100); void refresh() }}>Previous queues</button><button disabled={!snapshot || siteOffset + 100 >= snapshot.totals.careSites} onclick={() => { siteOffset += 100; void refresh() }}>Next queues</button></div>{/if}
      {#if selectedSite && selectedSite.revision !== siteRevision}<p class="warning">This care site changed since you opened the form. Your edits are preserved.</p><button onclick={() => selectSite(siteId)}>Reload current values</button>{/if}
      {#if selectedSite}<fieldset disabled={busy}>
        <legend>{selectedSite.label}</legend>
        <label class="check"><input type="checkbox" bind:checked={siteAccepting} />Accepting arrivals</label>
        <label>Simultaneous handovers<input type="number" min="0" max="1000" step="1" bind:value={siteSlots} /></label>
        <label>Assumed handover duration (seconds)<input type="number" min="0" max="86400" bind:value={siteSeconds} /></label>
        <label>Care capability tags<textarea rows="3" bind:value={siteCapabilities}></textarea></label>
        <label>Accepted urgency (one per line)<textarea rows="3" bind:value={siteUrgencies}></textarea></label>
        <button onclick={() => command('set-care-site', { careSiteId: siteId, accepting: siteAccepting, handoverSlots: siteSlots, handoverSeconds: siteSeconds, capabilities: lines(siteCapabilities), acceptedUrgencies: lines(siteUrgencies) }, siteRevision)}>Save care-site configuration</button>
      </fieldset>{/if}
    {:else if tab === 'metrics'}
      <h3>Operational measures</h3><p>Intervals include only completed milestone pairs. These are scenario logistics results, not clinical outcome predictions.</p>
      {#if metrics}
        <p>{metrics.incidents.awaitingFirstArrival} incidents awaiting first arrival · {metrics.patients.active} active patients · {metrics.patients.delivered} delivered · {metrics.patients.noTransport} no transport</p>
        <dl>{#each metricRows as { label, value }}<dt>{label}</dt><dd>{seconds(value.meanSeconds)} mean · {value.samples} samples · {seconds(value.maximumSeconds)} maximum</dd>{/each}</dl>
        <p>{metrics.units.dispatchable}/{metrics.units.total} units dispatchable · {seconds(metrics.units.busySeconds)} accumulated busy time</p>
        {#each metrics.limitations as limitation}<small>{limitation}</small>{/each}
      {:else}<p>Loading measures…</p>{/if}
    {:else}<CreateItemPanel {simulationRunId} {objects} {mapView} onCreated={() => { notice = 'Item created in this Run.'; void refresh() }} />{/if}
  </div>
  <footer>{loading ? 'Refreshing shared state…' : 'Shared state · updates each second'}<span>Scenario assumptions require research calibration</span></footer>
</section>

<style>
  .dispatch-panel{position:absolute;top:12px;right:12px;bottom:12px;width:min(470px,calc(100% - 24px));z-index:15;display:flex;flex-direction:column;pointer-events:auto;background:var(--panel,#101c2b);color:var(--text,#e2e8f0);border:1px solid #64748b77;border-radius:12px;box-shadow:0 10px 35px #0005;font-size:13px}header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #64748b55}header strong{font-size:16px}nav{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px;border-bottom:1px solid #64748b44}nav button{flex:1;padding:6px}.body{overflow:auto;padding:14px;flex:1;min-height:0}button,input,select,textarea{box-sizing:border-box;padding:8px;background:var(--panel,#182333);color:inherit;border:1px solid #64748b77;border-radius:5px}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}select,input:not([type=checkbox]),textarea{width:100%}label{display:grid;gap:5px;margin:9px 0}.patient-choice,.check{display:flex;align-items:center;gap:9px}.patient-choice input,.check input{flex:0}.patient-choice{padding:8px;border:1px solid #64748b44;border-radius:6px}small{display:block;color:var(--muted,#94a3b8);font-size:11px}p{color:var(--muted,#a8b7c9);line-height:1.4}h3{margin:17px 0 8px;font-size:14px}article{padding:10px;border:1px solid #64748b55;border-radius:7px;margin:8px 0}article p{margin:5px 0 9px}.active{background:#2563eb33;border-color:#60a5fa}.row{display:flex;gap:8px;margin:10px 0}fieldset{margin-top:12px;border:1px solid #64748b55;border-radius:6px;padding:12px}[role=alert],.warning{color:#f5ab71;white-space:pre-wrap}[role=status]{color:#86d5b1}dl{display:grid;gap:7px;margin-top:15px}dt{font-weight:600}dd{margin:0 0 8px;color:var(--muted,#a8b7c9)}footer{padding:8px 12px;border-top:1px solid #64748b44;font-size:10px;color:var(--muted,#94a3b8)}footer span{display:block;margin-top:3px}
</style>
