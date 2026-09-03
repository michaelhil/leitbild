import type { PackScenarioAuthoringField, WorldPack } from '../../core/packs/protocol.ts'
import { ambulanceRecordingProfiles, observationsFor } from './recording.ts'
import { ambulancePackConfigSchema, roadWeatherFields } from './road-weather.ts'
import { ambulanceScenarioSupport } from './scenario.ts'
import { ambulancePackView } from './ui-pack.ts'

const urgencyOptions = [{ value: 'acute', label: 'Acute' }, { value: 'urgent', label: 'Urgent' }, { value: 'ordinary', label: 'Ordinary' }]
const locationField: PackScenarioAuthoringField = { path: ['atObject'], label: 'At existing asset (instead of coordinates)', control: { kind: 'reference' } }
const placement = { kind: 'point' as const, path: ['position'], orReference: ['atObject'] }

export const ambulancePack: WorldPack = {
  ...ambulancePackView,
  scenarioConfigSchema: ambulancePackConfigSchema,
  recording: { profiles: ambulanceRecordingProfiles, estimateSeries: objects => objects.reduce((sum, object) => sum + observationsFor(object).length, 0) },
  scenario: ambulanceScenarioSupport,
  authoring: {
    configFields: roadWeatherFields,
    itemTypes: [{
      id: 'ambulance', label: 'Ambulance', idPrefix: 'ambulance',
      description: 'A response unit with explicit patient capacity, crew readiness and care capabilities. Mobilization and scene durations are editable operational assumptions, not validated clinical timings. Base defaults to the start point.',
      defaultItem: { patientCapacity: 1, capabilities: [], crewReady: true, mobilizationSeconds: 120, sceneSeconds: 900 }, placement,
      fields: [locationField,
        { path: ['patientCapacity'], label: 'Patient capacity', control: { kind: 'number', min: 1, max: 64, step: 1 } },
        { path: ['capabilities'], label: 'Care capability tags (one per line)', control: { kind: 'string-list' } },
        { path: ['crewReady'], label: 'Crew ready', control: { kind: 'boolean' } },
        { path: ['mobilizationSeconds'], label: 'Assumed mobilization (seconds)', control: { kind: 'number', min: 0, step: 1 } },
        { path: ['sceneSeconds'], label: 'Assumed scene service (seconds)', control: { kind: 'number', min: 0, step: 1 } },
        { path: ['basePosition', 0], label: 'Base longitude override', control: { kind: 'number', min: -180, max: 180, step: .0001 } },
        { path: ['basePosition', 1], label: 'Base latitude override', control: { kind: 'number', min: -90, max: 90, step: .0001 } },
      ],
    }, {
      id: 'incident', label: 'Incident', idPrefix: 'incident',
      description: 'A dispatch incident at a point or existing positioned asset. Add individual patient items to describe actual demand; dispatch urgency is separate from patient assessment.',
      defaultItem: { summary: '', dispatchUrgency: 'urgent' }, placement,
      fields: [locationField, { path: ['summary'], label: 'Situation summary', control: { kind: 'text' } }, { path: ['dispatchUrgency'], label: 'Dispatch urgency', control: { kind: 'select', options: urgencyOptions } }],
    }, {
      id: 'patient', label: 'Patient', idPrefix: 'patient',
      description: 'An individual patient belonging to an incident. Capability requirements and assessment are explicitly authored; no generated diagnoses or vital signs. Location follows patient custody.',
      defaultItem: { summary: '', assessedUrgency: 'urgent', needs: [] },
      fields: [
        { path: ['incidentId'], label: 'Incident', control: { kind: 'reference', itemTypes: ['incident'] } },
        { path: ['summary'], label: 'Patient / operational needs summary', control: { kind: 'text' } },
        { path: ['assessedUrgency'], label: 'Assessed urgency', control: { kind: 'select', options: urgencyOptions } },
        { path: ['needs'], label: 'Required care capability tags (one per line)', control: { kind: 'string-list' } },
      ],
    }, {
      id: 'care-site', label: 'Care site', idPrefix: 'care-site',
      description: 'A hospital or temporary receiving site, standalone or attached to an existing asset. Capabilities, accepted urgency and handover slots are explicit scenario assumptions, not claims about a real facility.',
      defaultItem: { capabilities: [], acceptedUrgencies: ['ordinary'], handoverSlots: 1, handoverSeconds: 900, accepting: true }, placement,
      fields: [locationField,
        { path: ['capabilities'], label: 'Care capability tags (one per line)', control: { kind: 'string-list' } },
        { path: ['acceptedUrgencies'], label: 'Accepted urgency (acute, urgent, ordinary; one per line)', control: { kind: 'string-list' } },
        { path: ['handoverSlots'], label: 'Simultaneous handovers', control: { kind: 'number', min: 0, max: 1000, step: 1 } },
        { path: ['handoverSeconds'], label: 'Assumed handover (seconds)', control: { kind: 'number', min: 0, step: 1 } },
        { path: ['accepting'], label: 'Accepting arrivals', control: { kind: 'boolean' } },
      ],
    }],
  },
}
