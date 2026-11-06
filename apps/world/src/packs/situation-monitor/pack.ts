import type { WorldPack } from '../../core/packs/protocol.ts'
import { situationConfigSchema } from './model.ts'
import { situationMonitorPackView } from './ui-pack.ts'

export const situationMonitorPack: WorldPack = {
  inspectionReferences: () => [],
  descriptor: situationMonitorPackView.descriptor,
  runtime: situationMonitorPackView.runtime!,
  presentation: situationMonitorPackView.presentation,
  ui: situationMonitorPackView.ui!,
  scenarioConfigSchema: situationConfigSchema,
  authoring: {
    configuration: {
      beforeStart: "Configure bounded sources and watched areas; this Pack has no OperationalObject item types. world.situation-monitor.adapters explains supported formats and mapping. Sources may be disabled for an offline scenario. intervalSeconds is wall-clock acquisition cadence (60–86400); retentionHours is wall-clock evidence retention (1–168). Coordinates/bounds use longitude then latitude.",
      liveChanges: "world.situation-monitor.configuration.replace validates an expected revision before replacing Run configuration; source refresh is an explicit bounded network command. Ordinary records/status/config reads use retained evidence and do not fetch. Source publication/observation/validity times and retrieval/freshness wall time remain distinct from simulation time.",
      requiresNewRevision: "Editing the authored Scenario creates a new Revision and affects later Runs only. Existing Run source edits use configuration.replace and persist separately; a restore resumes saved configuration/evidence, not the original authored source list.",
    },
    itemTypes: [], configFields: [],
  },
}
