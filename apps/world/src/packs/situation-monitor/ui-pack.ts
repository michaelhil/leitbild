import { createWorldPackDescriptor, type WorldPackView } from '../../core/packs/protocol.ts'
import { situationPackId, situationRuntimeId } from './model.ts'

export const situationMonitorPackView: WorldPackView = {
  descriptor: createWorldPackDescriptor({ id: situationPackId, version: '1.0.0', name: 'Situation Monitor', description: 'Live external reports, geographic features, forecasts and on-demand media, with provenance and explicit freshness. Independent of simulation time and physics.', contributions: ['runtime', 'scenario', 'presentation'] }),
  runtime: { runtimes: [{ id: situationRuntimeId, version: '1.0.0', label: 'External observations', kind: 'local', clock: 'live' }], defaultRuntimeId: situationRuntimeId },
  presentation: {
    categories: [],
    mapFeatureLayers: ['situation-monitor'],
    mapFeatureSourcePackIds: ['situation-monitor'],
    mapFeatureQueries: context => {
      const ring = context.map?.viewport.coordinates[0]
      if (!ring?.[0] || !ring[2]) return []
      return [{ capabilityId: 'world.situation-monitor.map.features', input: { bounds: [ring[0][0], ring[0][1], ring[2][0], ring[2][1]], limit: 1000 } }]
    },
    presentObject: () => { throw new Error('Situation Monitor owns external records, not operational objects') },
  },
  ui: {
    settingsEditor: async () => await import('./ui/SourceEditor.svelte'),
    surfacePanels: [{ id: 'situation-monitor.records', label: 'Situation Monitor', defaultOpen: true, load: async () => await import('./ui/MonitorPanel.svelte') }],
  },
}
