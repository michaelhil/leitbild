<script lang="ts">
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import { recordsPageSchema } from '../capabilities.ts'
  import type { ExternalRecord } from '../model.ts'
  import { invokeSituation } from './client.ts'
  const { simulationRunId, sourceId, dataRevision }: { simulationRunId: SimulationRunId; sourceId: string; dataRevision: number } = $props()
  let records = $state<ExternalRecord[]>([]), error = $state(''), selected = $state(''), limited = $state(false)
  const quantities = $derived([...new Map(records.flatMap(record => record.measurements.map(measure => [measure.id, measure] as const))).values()])
  const quantity = $derived(quantities.find(item => item.id === selected) ?? quantities[0])
  const points = $derived(records.flatMap(record => { const measure = record.measurements.find(item => item.id === quantity?.id && item.unit === quantity?.unit); return measure ? [{ at: Date.parse(record.validAt ?? record.publishedAt ?? record.retrievedAt), value: measure.value }] : [] }).sort((a,b) => a.at - b.at))
  const low = $derived(Math.min(...points.map(point => point.value))), high = $derived(Math.max(...points.map(point => point.value)))
  const path = $derived(points.map(point => `${20 + 330 * (point.at - points[0]!.at) / (points.at(-1)!.at - points[0]!.at || 1)},${130 - 110 * (point.value - low) / (high - low || 1)}`).join(' '))
  const forecast = $derived(records.length > 0 && records.every(record => record.kind === 'forecast'))
  $effect(() => {
    dataRevision
    let active = true
    void invokeSituation('records.search', { sourceId, limit: 200 }, { simulationRunId }).then(recordsPageSchema.parse).then(page => { if (active) { records = page.records; limited = page.hasMore; error = '' } }).catch(cause => { if (active) error = String(cause) })
    return () => { active = false }
  })
</script>
{#if quantities.length}<section aria-label="External measurements"><h3>{forecast ? 'Forecast series' : 'Reported measurements'}</h3><select aria-label="Measurement" bind:value={selected}>{#each quantities as item}<option value={item.id}>{item.id} ({item.unit})</option>{/each}</select>
  {#if points.length > 1}<svg viewBox="0 0 380 165" role="img" aria-label={`${quantity?.id}: ${low} to ${high} ${quantity?.unit}`}>
    <line x1="20" y1="130" x2="350" y2="130" stroke="#64748b" />
    {#if forecast}<polyline points={path} fill="none" stroke="#38bdf8" stroke-width="2" />{:else}{#each path.split(' ') as pair}<circle cx={Number(pair.split(',')[0])} cy={Number(pair.split(',')[1])} r="3" fill="#38bdf8" />{/each}{/if}
    <text x="20" y="12" fill="currentColor" font-size="10">{low}–{high} {quantity?.unit}</text><text x="20" y="152" fill="currentColor" font-size="9">{new Date(points[0]!.at).toLocaleString()}</text><text x="350" y="152" text-anchor="end" fill="currentColor" font-size="9">{new Date(points.at(-1)!.at).toLocaleString()}</text>
  </svg>{:else}<p>Not enough measurements to draw a series.</p>{/if}
  <small>{forecast ? 'Provider forecast-valid times, not observed history.' : 'Separate reported values; dots do not imply a continuous series.'} {limited ? 'Most recent 200 records shown.' : 'Current retained provider window.'}</small></section>{/if}
{#if error}<p role="alert">{error}</p>{/if}
<style>section{margin:14px 0;padding:10px;border:1px solid #64748b66;border-radius:6px}svg,select{width:100%}select{background:#152235;color:inherit;padding:6px;border:1px solid #64748b}small{font-size:11px;color:#94a3b8}[role=alert]{color:#f87171}</style>
