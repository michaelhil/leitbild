import { join } from 'node:path'
import { z } from 'zod'
import { isMapSymbol } from '../../core/map-symbols/catalog.ts'
import { nowIso, type CommandResult } from '../../core/model/index.ts'
import type { PackRuntimeAdapter, PackRuntimeEventHandler, PackWorkspaceCapability } from '../../simulation/protocol.ts'
import { describeSourceAdapters, recordForSource, roadDatasets } from './adapters/catalog.ts'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { decodeSource } from './adapters/decode.ts'
import { sourceRequestUrl } from './adapters/catalog.ts'
import { createCollector, collectionKey } from './ingestion/collector.ts'
import { openRecordStore } from './ingestion/store.ts'
import { publicHttp } from './ingestion/public-http.ts'
import { recordMapFeatures, watchedAreaFeatures } from './map.ts'
import { situationCapabilities, replaceConfigSchema, refreshSourceSchema } from './capabilities.ts'
import { externalRecordSchema, recordSearchSchema, situationConfigSchema, situationRuntimeId, situationSourceSchema, situationStateSchema, sourceUrlSchema, type ExternalRecord, type SourceStatus } from './model.ts'

const workspaces = new Map<string, { store: ReturnType<typeof openRecordStore>; collector: ReturnType<typeof createCollector>; users: number }>()
const closingWorkspaces = new Map<string, Promise<void>>()
const probeInput = z.object({ source: situationSourceSchema }).strict()
const probeOutput = z.object({ records: z.array(externalRecordSchema), count: z.number().int(), observedAt: z.iso.datetime() }).strict()
const probeTimes = new Map<string, number>()
let activeProbes = 0
export const situationWorkspaceCapabilities: ReadonlyArray<PackWorkspaceCapability> = [{
  id: 'world.situation-monitor.source.probe', title: 'Test an external source', description: 'Make one bounded public-network source request and preview up to five records. Does not save a source, start a Run or retain records. Rate limited; authenticated sources must be configured in a Run.',
  kind: 'command', risk: 'write', idempotent: false, input: probeInput, output: probeOutput,
  invoke: async raw => {
    const { source } = probeInput.parse(raw)
    if (source.credentialRef) throw new Error('Configure credentialed sources in a Run; preview does not use server secrets')
    const url = sourceRequestUrl(source), origin = new URL(url).origin
    for (const [key, until] of probeTimes) if (until <= Date.now()) probeTimes.delete(key)
    if (activeProbes >= 2) throw new Error('Source previews are busy; try again shortly')
    if ((probeTimes.get(origin) ?? 0) > Date.now()) throw new Error('Source probe rate limit: try again in a minute')
    probeTimes.set(origin, Date.now() + 60000)
    activeProbes++
    try {
      const response = source.adapter === 'media' ? null : await publicHttp(url)
      if (response && response.status !== 200) throw new Error('Source probe returned HTTP ' + response.status)
      if (response?.headers['cache-control']?.includes('no-store')) throw new Error('Provider disallows caching this source')
      const observedAt = new Date().toISOString(), records = decodeSource(source, response?.text ?? '', observedAt)
      return { records: records.slice(0, 5).map(record => recordForSource(record, source)), count: records.length, observedAt }
    } finally { activeProbes-- }
  },
}, {
  id: 'world.situation-monitor.adapters', title: 'Discover Situation Monitor adapters', description: 'Discover supported formats/provider adapters, configuration schemas, modalities and collection constraints. Does not start collection.',
  kind: 'query', risk: 'read', idempotent: true, input: z.object({}).strict(), output: z.object({ adapters: z.array(z.record(z.string(), z.unknown())) }).strict(),
  invoke: async () => ({ adapters: describeSourceAdapters().map(adapter => adapter.id === 'vegvesen' ? { ...adapter, datasets: roadDatasets } : adapter) }),
}, {
  id: 'world.situation-monitor.catalogue.discover', title: 'Discover provider datasets', description: 'Fetch a bounded WFS GetCapabilities document and identify advertised datasets compatible with the Vegvesen semantic adapter. Does not start collection or create sources. Other WFS feature types require a compatible decoder; arbitrary web crawling is not supported.',
  kind: 'command', risk: 'write', idempotent: false,
  input: z.object({ url: sourceUrlSchema }).strict(),
  output: z.object({ datasets: z.array(z.object({ id: z.string(), title: z.string(), typeName: z.string(), icon: z.string() }).strict()), advertisedTypes: z.number().int() }).strict(),
  invoke: async raw => {
    const { url: endpoint } = z.object({ url: sourceUrlSchema }).parse(raw), url = new URL(endpoint)
    if (activeProbes >= 2 || (probeTimes.get(url.origin) ?? 0) > Date.now()) throw new Error('Provider discovery rate limit: try again in a minute')
    probeTimes.set(url.origin, Date.now() + 60000); activeProbes++
    try {
      url.searchParams.set('service', 'WFS'); url.searchParams.set('request', 'GetCapabilities')
      const response = await publicHttp(url.href)
      if (response.status !== 200) throw new Error('Provider catalogue HTTP ' + response.status)
      if (/<!DOCTYPE|<!ENTITY/i.test(response.text) || XMLValidator.validate(response.text) !== true) throw new Error('Invalid provider catalogue XML')
      const document = new XMLParser({ removeNSPrefix: true, maxNestedTags: 64 }).parse(response.text)
      const features = document.WFS_Capabilities?.FeatureTypeList?.FeatureType
      if (!features) throw new Error('Provider did not return a WFS feature catalogue')
      const list = Array.isArray(features) ? features : [features]
      const names = new Set(list.map(feature => String(feature.Name)))
      return { datasets: roadDatasets.filter(dataset => names.has(dataset.typeName)), advertisedTypes: names.size }
    } finally { activeProbes-- }
  },
}]

export const createSituationMonitorRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: situationRuntimeId, version: '1.0.0', packId: 'situation-monitor', clock: 'none', capabilities: situationCapabilities,
  workspaceCapabilities: situationWorkspaceCapabilities,
  connect: async config => {
    if (!config.workspace || !config.runtimeStateStore) throw new Error('Situation Monitor requires Workspace persistence and a Pack state store')
    const validateIcons = (value: z.infer<typeof situationConfigSchema>) => {
      for (const source of value.sources) if (source.map.icon && !isMapSymbol(source.map.icon)) throw new Error('Unknown source map icon: ' + source.map.icon + '; discover names with world.map.symbols')
      return value
    }
    const initial = validateIcons(situationConfigSchema.parse(config.scenario.runtimeConfig))
    const raw = await config.runtimeStateStore.load()
    if (config.initialObjects && raw === null) throw new Error('Situation Monitor checkpoint missing on restored Run')
    let state = raw === null ? { revision: 0, config: initial } : situationStateSchema.parse(raw)
    if (raw === null) await config.runtimeStateStore.save(state)
    const directory = join(config.workspace.dataDir, 'situation-monitor')
    await closingWorkspaces.get(directory)
    let shared = workspaces.get(directory)
    if (!shared) {
      const store = openRecordStore(join(directory, 'snapshots.sqlite'))
      const workspace = config.workspace
      const collector = createCollector(store, publicHttp, async (bytes, work) => {
        if (!workspace.storageBudget) throw new Error('Situation Monitor requires the shared Workspace storage budget')
        await workspace.storageBudget.withGrowth(workspace.dataDir, bytes, work)
      })
      shared = { store, collector, users: 0 }; workspaces.set(directory, shared)
    }
    shared.users++
    const service = shared
    const handlers = new Set<PackRuntimeEventHandler>()
    const leases = new Map<string, ReturnType<typeof service.collector.acquire>>()
    let closed = false, dataRevision = 0
    const changed = () => {
      if (closed) return
      const at = nowIso()
      dataRevision++
      for (const handler of handlers) handler({ type: 'event.emission', runtimeId: situationRuntimeId, events: [], emittedAt: at, realtimeMessages: [{ type: 'pack.data.changed', at, payload: { packId: 'situation-monitor', revision: dataRevision } }] })
    }
    const sync = async () => {
      const sources = closed ? [] : state.config.sources.filter(source => source.enabled)
      const wanted = new Map(sources.map(source => [source.id, source]))
      for (const [id, lease] of leases) if (!wanted.has(id) || lease.key !== collectionKey(wanted.get(id)!) || lease.intervalSeconds !== wanted.get(id)!.intervalSeconds) { leases.delete(id); await lease.release() }
      for (const source of sources) if (!leases.has(source.id)) leases.set(source.id, service.collector.acquire(source, changed))
    }
    await sync()
    const connectedAt = nowIso()
    const statuses = (): SourceStatus[] => state.config.sources.map(source => leases.get(source.id)?.status() ?? { sourceId: source.id, state: 'paused', lastAttemptAt: null, lastSuccessAt: service.store.metadata(collectionKey(source)).lastSuccessAt ?? null, nextAttemptAt: null, recordCount: service.store.count(collectionKey(source)), error: null })
    const decorate = (record: ExternalRecord): ExternalRecord => {
      const source = state.config.sources.find(item => item.id === record.sourceId)!
      return recordForSource(record, source)
    }
    const search = (input: z.infer<typeof recordSearchSchema>, mapAt?: number) => {
      const page = service.store.search(state.config.sources.filter(source => mapAt === undefined || source.map.visible).map(source => ({ id: source.id, key: collectionKey(source) })), input, state.config.areas, mapAt)
      return { ...page, records: page.records.map(decorate) }
    }
    let commandQueue = Promise.resolve()
    let mapCache: { key: string; result: { features: ReturnType<typeof recordMapFeatures>; truncated: boolean } } | undefined
    return {
      getSnapshot: async () => ({ simulationRunId: config.simulationRunId, objects: [], capturedAt: nowIso() }),
      subscribe: handler => { handlers.add(handler); return () => { handlers.delete(handler) } },
      invokeQuery: async query => {
        if (closed) throw new Error('Situation Monitor is closed')
        if (query.capabilityId === 'world.situation-monitor.map.features') {
          const input = situationCapabilities.find(item => item.id === query.capabilityId)!.input.parse(query.input) as { bounds: [number,number,number,number]; limit: number }
          const key = JSON.stringify([input, state.revision, dataRevision, Math.floor(Date.now() / 60000)])
          if (mapCache?.key === key) return mapCache.result
          const located = search({ ...recordSearchSchema.parse({ bounds: input.bounds }), limit: input.limit }, Date.now())
          const bounded: ReturnType<typeof recordMapFeatures> = [], maximumVertices = 50000
          let vertices = 0
          let truncated = located.hasMore
          for (const record of located.records) {
            for (const feature of recordMapFeatures(record, state.config.sources.find(source => source.id === record.sourceId))) {
              const count = feature.geometry.type === 'Point' ? 1 : feature.geometry.type === 'LineString' ? feature.geometry.coordinates.length : feature.geometry.coordinates.reduce((sum,ring) => sum + ring.length, 0)
              if (bounded.length >= input.limit || vertices + count > maximumVertices) { truncated = true; continue }
              vertices += count; bounded.push(feature)
            }
          }
          const result = { features: [...watchedAreaFeatures(state.config.areas), ...bounded], truncated }
          mapCache = { key, result }; return result
        }
        if (query.capabilityId === 'world.situation-monitor.status') return { revision: state.revision, config: state.config, sources: statuses(), storage: service.store.stats(), observationTime: new Date().toISOString(), limitations: ['External reports are not verified physical truth.', 'Retains the provider’s latest feed window, not a complete archive.', 'Forecasts use provider valid time; simulation pause/speed does not affect collection.'] }
        if (query.capabilityId === 'world.situation-monitor.records.search') return search(recordSearchSchema.parse(query.input))
        if (query.capabilityId === 'world.situation-monitor.record.inspect') {
          const input = z.object({ sourceId: z.string(), recordId: z.string() }).parse(query.input)
          const source = state.config.sources.find(source => source.id === input.sourceId)
          const record = source ? service.store.inspect(collectionKey(source), input.recordId) : null
          if (!record) return null
          return decorate({ ...record, sourceId: input.sourceId })
        }
        throw new Error('Unknown Situation Monitor query: ' + query.capabilityId)
      },
      sendCommand: command => {
        const execute = async (): Promise<CommandResult> => {
          try {
            if (closed) throw new Error('Situation Monitor is closed')
            if ('lastCommandId' in state && state.lastCommandId === command.id) return { ok: true, commandId: command.id, acceptedAt: nowIso() }
            if (command.kind === 'world.situation-monitor.configuration.replace') {
              const input = replaceConfigSchema.parse(command.payload)
              validateIcons(input.config)
              if (input.expectedRevision !== state.revision) throw new Error('Source configuration changed; reload before saving')
              const next = { revision: state.revision + 1, config: input.config, lastCommandId: command.id }
              await config.runtimeStateStore!.save(next); state = next; await sync(); changed()
            } else if (command.kind === 'world.situation-monitor.source.refresh') {
              const input = refreshSourceSchema.parse(command.payload), lease = leases.get(input.sourceId)
              if (!lease) throw new Error('Source is missing or paused')
              void lease.refresh()
            } else throw new Error('Unknown Situation Monitor command: ' + command.kind)
            return { ok: true, commandId: command.id, acceptedAt: nowIso() }
          } catch (error) { return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: error instanceof Error ? error.message : String(error) } }
        }
        const result = commandQueue.then(execute); commandQueue = result.then(() => {}); return result
      },
      // This adapter owns evidence/configuration, not operational objects or a physical clock.
      observeCommittedEvents: async () => {}, setClock: async () => {},
      health: () => [{ runtimeId: situationRuntimeId, state: statuses().some(status => status.state === 'error') ? 'degraded' : 'ready', failureCount: statuses().filter(status => status.state === 'error').length, lastSuccessfulInteractionAt: connectedAt }],
      close: async () => {
        closed = true; await commandQueue; await sync(); handlers.clear()
        service.users--
        if (!service.users) {
          workspaces.delete(directory)
          const pending = service.collector.close()
          closingWorkspaces.set(directory, pending)
          try { await pending } finally { closingWorkspaces.delete(directory) }
        }
      },
    }
  },
})
