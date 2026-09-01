import type { WorldPack } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../../core/packs/protocol.ts'
import { electricGridPackConfigSchema } from './config.ts'
import {
  norwayGridModelRef,
  norwayNormalOperatingPointRef,
  norwayStandardAutomationRef,
  electricGridDefinitionCatalog,
} from './definition-refs.ts'
import { electricGridPackId } from './model.ts'
import { electricGridRecordingProfiles } from './recording.ts'
import { electricGridScenarioSupport } from './scenario.ts'
import { electricGridUiPack } from './ui-pack.ts'

export const electricGridPack: WorldPack = {
  ...electricGridUiPack,
  descriptor: createWorldPackDescriptor({
    id: electricGridPackId,
    version: '1.0.0',
    name: 'Electric Grid',
    contributions: ['runtime', 'recording', 'reference-data', 'scenario', 'presentation'],
  }),
  scenarioConfigSchema: electricGridPackConfigSchema,
  authoring: {
    itemTypes: [{
      id: 'grid',
      label: 'Electric grid',
      description: 'A map-visible Grid backed by a selected model, operating point, and automation definition.',
      idPrefix: 'grid',
      defaultItem: {
        model: { ref: norwayGridModelRef },
        operatingPoint: {
          ref: norwayNormalOperatingPointRef,
          overrides: { loadScale: 1.03, generationAvailabilityScale: 1, storageStateOfCharge: 0.58 },
        },
        automation: { ref: norwayStandardAutomationRef },
      },
      placement: { target: 'item', path: ['location'] },
      fields: [{
        target: 'item', path: ['model', 'ref'], label: 'Grid Model',
        control: { kind: 'select', defaultValue: norwayGridModelRef, options: electricGridDefinitionCatalog.models.map(model => ({ value: model.id, label: model.title })) },
      }, {
        target: 'item', path: ['operatingPoint', 'ref'], label: 'Operating Point',
        control: { kind: 'select', defaultValue: norwayNormalOperatingPointRef, options: electricGridDefinitionCatalog.operatingPoints.map(point => ({ value: point.id, label: point.title })) },
      }, {
        target: 'item', path: ['automation', 'ref'], label: 'Automation',
        control: { kind: 'select', defaultValue: norwayStandardAutomationRef, options: electricGridDefinitionCatalog.automations.map(automation => ({ value: automation.id, label: automation.title })) },
      }, {
        target: 'item', path: ['operatingPoint', 'overrides', 'loadScale'], label: 'Load scale',
        control: { kind: 'number', defaultValue: 1.03, min: 0.01, step: 0.01 },
      }, {
        target: 'item', path: ['operatingPoint', 'overrides', 'generationAvailabilityScale'], label: 'Generation availability scale',
        control: { kind: 'number', defaultValue: 1, min: 0, step: 0.01 },
      }, {
        target: 'item', path: ['operatingPoint', 'overrides', 'storageStateOfCharge'], label: 'Initial storage charge',
        control: { kind: 'number', defaultValue: 0.58, min: 0, max: 1, step: 0.01 },
      }],
    }],
  },
  recording: { profiles: electricGridRecordingProfiles },
  scenario: electricGridScenarioSupport,
}
