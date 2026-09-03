<script lang="ts">
  import type { z } from 'zod'
  import type { WorkspaceDefinitionRevisionReference } from '@leitbild/contracts'
  import type { ScenarioDefinition } from '../../../core/scenarios/definition.ts'
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import { runOnMount } from '../../../ui/svelte-lifecycle.svelte.ts'
  import { parseControlSurfaceRoute } from '../../../ui/simulation-run-route.ts'
  import { situationStatusSchema, recordsPageSchema } from '../capabilities.ts'
  import { geometryBounds, type ExternalRecord, type SituationConfig } from '../model.ts'
  import { recordAppearance } from '../map.ts'
  import SourceEditor from './SourceEditor.svelte'
  import MediaPlayer from './MediaPlayer.svelte'
  import { invokeSituation } from './client.ts'
  import { invokeWorld } from '../../../ui/workspace-capability-client.ts'
  import MeasurementChart from './MeasurementChart.svelte'
  import type { MapView } from '../../../ui/map-view.ts'
  const { simulationRunId, onClose, onFocusMap = () => {}, dataRevision = 0, selectedItemId = null, mapView = null }: { simulationRunId: SimulationRunId; onClose: () => void; onFocusMap?: (target: { kind: 'bounds'; bounds: readonly [readonly [number, number], readonly [number, number]] }) => void; dataRevision?: number; selectedItemId?: string | null; mapView?: MapView | null } = $props()
  const workspaceId = parseControlSurfaceRoute(location.pathname).workspaceId
  let status = $state<z.infer<typeof situationStatusSchema> | null>(null)
  let page = $state<z.infer<typeof recordsPageSchema> | null>(null)
  let error = $state(''), notice = $state(''), loading = $state(false)
  let text = $state(''), sourceId = $state(''), offset = $state(0)
  let tab = $state<'records' | 'sources'>('records')
  let selected = $state<ExternalRecord | null>(null)
  let edited = $state<SituationConfig | null>(null)
  let savingScenario = $state(false)
  let editRevision = $state<number | null>(null)
  let sequence = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    const request = ++sequence
    loading = true
    const inspecting = selected
    const inspection = inspecting ? invokeSituation<ExternalRecord>('record.inspect', { sourceId: inspecting.sourceId, recordId: inspecting.id }, { simulationRunId }).catch(cause => ({ unavailable: String(cause) })) : Promise.resolve(null)
    try {
      const [nextStatus, nextPage, nextSelected] = await Promise.all([
        invokeSituation('status', {}, { simulationRunId }).then(situationStatusSchema.parse),
        invokeSituation('records.search', { text, ...(sourceId ? { sourceId } : {}), offset, limit: 50 }, { simulationRunId }).then(recordsPageSchema.parse),
        inspection,
      ])
      if (disposed || request !== sequence) return
      status = nextStatus; page = nextPage; error = ''
      if (selected?.id === inspecting?.id && selected?.sourceId === inspecting?.sourceId && nextSelected) {
        if ('unavailable' in nextSelected) { selected = null; notice = 'Selected evidence is no longer available: ' + nextSelected.unavailable }
        else selected = nextSelected
      }
    } catch (cause) { if (!disposed && request === sequence) error = String(cause) }
    finally { if (!disposed && request === sequence) loading = false }
  }
  function search() { offset = 0; void refresh() }
  async function save() {
    if (!edited || editRevision === null) return
    try { await invokeSituation('configuration.replace', { expectedRevision: editRevision, config: edited }, { simulationRunId }); edited = null; editRevision = null; notice = 'Saved to this Run. The reusable Scenario is unchanged.'; await refresh() }
    catch (cause) { error = String(cause) }
  }
  async function refreshSource(id: string) {
    try { await invokeSituation('source.refresh', { sourceId: id }, { simulationRunId }); await refresh() } catch (cause) { error = String(cause) }
  }
  async function saveScenario() {
    if (!status || !confirm('Save this Run’s source and watched-area configuration to a new revision of its original Scenario? Other scenario settings are preserved.')) return
    savingScenario = true; error = ''; notice = ''
    try {
      const original = await invokeWorld<{ source: ScenarioDefinition; definition: WorkspaceDefinitionRevisionReference }>('world.simulation-run.scenario-source', {}, { simulationRunId })
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/world/scenarios/${encodeURIComponent(original.definition.id)}`)
      if (!response.ok) throw new Error('The original Scenario is no longer available for editing')
      const current = await response.json() as { source: ScenarioDefinition; revisionId: WorkspaceDefinitionRevisionReference['revisionId'] }
      if (!current.source.packs.some(pack => pack.id === 'situation-monitor')) throw new Error('Situation Monitor was removed from the Scenario. Add it in the editor before saving Run settings.')
      const source = { ...current.source, packs: current.source.packs.map(pack => pack.id === 'situation-monitor' ? { ...pack, config: status!.config } : pack) }
      await invokeWorld('world.scenario.update', { source }, { definition: { ...original.definition, revisionId: current.revisionId } })
      notice = 'Saved a new Scenario revision. Existing Runs are unchanged.'
    } catch (cause) { error = String(cause) }
    finally { savingScenario = false }
  }
  async function background(enabled: boolean) {
    try { await invokeWorld('world.simulation-run.execution', { background: enabled }, { simulationRunId }); notice = enabled ? 'Background execution enabled until disabled, unloaded or the service restarts.' : 'Background execution disabled; normal viewer/API leases still apply.' }
    catch (cause) { error = String(cause) }
  }
  async function showSource(id: string, visible: boolean) {
    if (!status) return
    try { await invokeSituation('configuration.replace', { expectedRevision: status.revision, config: { ...status.config, sources: status.config.sources.map(source => source.id === id ? { ...source, map: { ...source.map, visible } } : source) } }, { simulationRunId }); await refresh() }
    catch (cause) { error = String(cause) }
  }
  function focus(record: ExternalRecord) { if (record.geometry) { const [w,s,e,n] = geometryBounds(record.geometry); onFocusMap({ kind: 'bounds', bounds: [[w,s],[e,n]] }) } }
  runOnMount(() => {
    disposed = false
    const poll = async () => { await refresh(); if (!disposed) timer = setTimeout(poll, 15000) }
    void poll()
    return () => { disposed = true; sequence++; clearTimeout(timer) }
  })
  $effect(() => { if (dataRevision) void refresh() })
  $effect(() => {
    if (!selectedItemId) return
    const [sourceId, recordId] = JSON.parse(selectedItemId) as [string, string]
    let active = true
    void invokeSituation<ExternalRecord>('record.inspect', { sourceId, recordId }, { simulationRunId }).then(record => { if (active) { selected = record; tab = 'records' } }).catch(cause => { if (active) error = String(cause) })
    return () => { active = false }
  })
</script>
<section class="monitor" aria-label="Situation Monitor">
  <header><strong>Situation Monitor</strong><button aria-label="Close Situation Monitor" onclick={onClose}>×</button></header>
  <nav><button class:active={tab === 'records'} onclick={() => tab = 'records'}>Records</button><button class:active={tab === 'sources'} onclick={() => tab = 'sources'}>Sources</button><span>{loading ? 'Updating…' : status ? status.sources.filter(source => source.state === 'ready').length + '/' + status.sources.length + ' sources ready' : 'Connecting…'}</span></nav>
  <div class="body">
  {#if error}<p role="alert">{error}</p>{/if}{#if notice}<p role="status">{notice}</p>{/if}
  {#if status && tab === 'sources'}
    <SourceEditor config={edited ?? status.config} {workspaceId} {mapView} onchange={value => { if (editRevision === null) editRevision = status!.revision; edited = value as SituationConfig; notice = '' }} />
    {#if edited}<div class="row"><button onclick={save}>Save Run configuration</button><button onclick={() => { edited = null; editRevision = null }}>Discard changes</button></div>{/if}
    <button onclick={saveScenario} disabled={savingScenario || edited !== null}>{savingScenario ? 'Saving…' : 'Save sources to Scenario'}</button>
    <details><summary>Execution lifetime</summary><p>Collection runs while this Run is loaded. Without viewers or API activity, the normal idle-unload policy applies. Background execution lasts until disabled, unloaded or the service restarts; it is not a permanent scheduled monitor.</p><div class="row"><button onclick={() => background(true)}>Keep running without viewers</button><button onclick={() => background(false)}>Use normal idle policy</button></div></details>
    <h3>Collection status</h3>
    {#each status.sources as source}<article><strong>{status.config.sources.find(item => item.id === source.sourceId)?.name}</strong><p>{source.state} · {source.recordCount} retained records</p><small>Last success: {source.lastSuccessAt ? new Date(source.lastSuccessAt).toLocaleString() : 'Never'}<br />Next eligible request: {source.nextAttemptAt ? new Date(source.nextAttemptAt).toLocaleString() : '—'}</small>{#if source.error}<p role="alert">{source.error}</p>{/if}<button disabled={source.state === 'paused'} onclick={() => refreshSource(source.sourceId)}>Request refresh</button></article>{/each}
    <p>{(status.storage.bytes / 1024 ** 2).toFixed(1)} / {Math.round(status.storage.maxBytes / 1024 ** 2)} MiB shared Workspace cache · maximum {status.storage.maxRecords.toLocaleString()} records.</p>
    {#each status.limitations as limitation}<small>{limitation}</small>{/each}
  {:else}
    <details class="legend"><summary>Map layers · real-time evidence</summary>{#each status?.config.sources ?? [] as source}<label><input type="checkbox" checked={source.map.visible} onchange={event => showSource(source.id, event.currentTarget.checked)} disabled={edited !== null} /><span style:background={recordAppearance({ kind: source.adapter === 'met-alerts' ? 'event' : source.adapter === 'met-forecast' ? 'forecast' : source.adapter === 'vegvesen' && source.dataset === 'cameras' ? 'media' : 'observation' }, source).color}></span>{source.name}</label>{/each}<small>Warnings use provider severity colours unless overridden. Traffic includes scheduled work; inspect validity and advice. Camera markers do not guarantee current frames.</small></details>
    <form onsubmit={event => { event.preventDefault(); search() }}><input aria-label="Search external records" bind:value={text} placeholder="Search retained reports…" /><button>Search</button></form>
    <select aria-label="Filter source" bind:value={sourceId} onchange={search}><option value="">All sources</option>{#each status?.config.sources ?? [] as source}<option value={source.id}>{source.name}</option>{/each}</select>
    {#if selected}<article class="inspector"><div class="row"><h3>{selected.title}</h3><button aria-label="Close record" onclick={() => selected = null}>×</button></div><p>{selected.summary}</p><dl><dt>Source</dt><dd>{selected.sourceId}</dd><dt>Snapshot fetched</dt><dd>{new Date(selected.retrievedAt).toLocaleString()}</dd>{#if selected.publishedAt}<dt>Published</dt><dd>{new Date(selected.publishedAt).toLocaleString()}</dd>{/if}{#if selected.updatedAt}<dt>Updated</dt><dd>{new Date(selected.updatedAt).toLocaleString()}</dd>{/if}{#if selected.validAt}<dt>Valid at</dt><dd>{new Date(selected.validAt).toLocaleString()}</dd>{/if}{#if selected.observedAt}<dt>Observed / image updated</dt><dd>{new Date(selected.observedAt).toLocaleString()}</dd>{/if}{#if selected.validFrom}<dt>Valid from</dt><dd>{new Date(selected.validFrom).toLocaleString()}</dd>{/if}{#if selected.validUntil}<dt>Valid until</dt><dd>{new Date(selected.validUntil).toLocaleString()}{Date.parse(selected.validUntil) < Date.now() ? ' · Expired' : ''}</dd>{/if}{#if selected.severity}<dt>Severity</dt><dd>{selected.severity}</dd>{/if}{#each selected.measurements as measure}<dt>{measure.id}</dt><dd>{measure.value} {measure.unit}</dd>{/each}</dl>{#each Object.entries(selected.details) as [label, detail]}{#if detail}<p class="detail"><strong>{label}</strong><br />{detail}</p>{/if}{/each}<a href={selected.url} target="_blank" rel="noopener noreferrer">Original source ↗</a><p>{selected.attribution}</p>{#if selected.geometry}<button onclick={() => focus(selected!)}>Show on map</button>{/if}{#each selected.media as media (selected.sourceId + selected.id + media.format + media.url)}<MediaPlayer {media} title={selected.title} observedAt={selected.observedAt} />{/each}<details><summary>All record data</summary><pre>{JSON.stringify(selected, null, 2)}</pre></details></article>{/if}
    {#if selected?.measurements.length && selected.subject}{#key selected.sourceId + selected.subject.id}<MeasurementChart {simulationRunId} sourceId={selected.sourceId} subjectId={selected.subject.id} {dataRevision} />{/key}{/if}
    {#if page?.records.length}{#each page.records as record (record.sourceId + '\u0000' + record.id)}<button class="record" onclick={() => selected = record}><strong>{record.title}</strong><small>{record.kind} · {status?.config.sources.find(source => source.id === record.sourceId)?.name ?? record.sourceId} · {new Date(record.validAt ?? record.observedAt ?? record.publishedAt ?? record.retrievedAt).toLocaleString()}{record.geometry ? ' · Located' : ''}</small><span>{record.summary.slice(0, 180)}</span></button>{/each}{:else if !loading}<p>No retained records match. Open Sources to configure collection or inspect errors. An empty result does not establish that nothing happened.</p>{/if}
    <div class="row"><button disabled={offset === 0} onclick={() => { offset = Math.max(0, offset - 50); void refresh() }}>Previous</button><span>{page?.total ?? 0} records</span><button disabled={!page?.hasMore} onclick={() => { offset += 50; void refresh() }}>Next</button></div>
  {/if}
  </div>
</section>
<style>
  .legend{margin:8px 0 14px}.legend label{display:flex;align-items:center;gap:6px;margin:7px 0}.legend input{flex:0}.legend span{width:10px;height:10px;border-radius:50%}.detail{white-space:pre-wrap}
  .monitor{position:absolute;top:16px;right:16px;bottom:16px;width:min(460px,calc(100% - 32px));z-index:15;background:var(--panel,#101c2b);color:var(--text,#e2e8f0);border:1px solid #64748b66;border-radius:10px;box-shadow:0 10px 30px #0005;display:flex;flex-direction:column;pointer-events:auto;font-size:13px}header,nav,.row,form{display:flex;gap:8px;align-items:center}header{padding:12px 16px;justify-content:space-between;border-bottom:1px solid #64748b55}nav{padding:8px 14px}nav span{margin-left:auto;color:#94a3b8;font-size:11px}.body{overflow:auto;padding:0 16px 16px}button,input,select{padding:7px 9px;background:transparent;border:1px solid #64748b77;border-radius:5px;color:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}input{min-width:0;flex:1}select{width:100%;margin:8px 0;background:var(--panel,#101c2b)}.active,.inspector{border-color:#60a5fa;background:#2563eb15}small{display:block;color:#94a3b8;font-size:11px}p{color:var(--muted,#a8b7c9)}.record{display:block;text-align:left;width:100%;margin:7px 0;padding:10px}.record strong,.record span{display:block}.record span{font-size:12px;margin-top:5px;color:#94a3b8}article{border:1px solid #64748b55;padding:12px;border-radius:7px;margin:10px 0}.row{justify-content:space-between}h3{margin:8px 0}a{color:#60a5fa}dl{display:grid;grid-template-columns:auto 1fr;gap:5px;font-size:12px}dd{margin:0;overflow-wrap:anywhere}dt{color:#94a3b8}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}[role=alert]{color:#f87171;white-space:pre-wrap;overflow-wrap:anywhere}details{margin-top:12px}summary{cursor:pointer}
</style>
