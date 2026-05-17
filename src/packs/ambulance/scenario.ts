import type { IsoTimestamp, ObjectId, ScenarioDefinition } from '../../core/model/index.ts'
import { geoPointFromLonLat, scenarioDefinitionSchema } from '../../core/model/index.ts'
import { trafficSimProviderId } from '../traffic/sim/constants.ts'
import { ambulanceDomainId } from './model.ts'
import { ambulanceSimProviderId } from './sim/constants.ts'
import {
  createScenarioAmbulanceObject,
  createScenarioHospitalObject,
  createScenarioIncidentObject,
} from './sim/object-state.ts'

const scenarioStart = '2026-01-01T09:00:00.000Z' as IsoTimestamp

export const osloAmbulanceTutorialScenario = scenarioDefinitionSchema.parse({
  id: 'ambulance:oslo-tutorial',
  schemaVersion: 1,
  title: 'Oslo ambulance tutorial',
  description: 'A small Oslo ambulance dispatch scenario with one ambulance, one incident, and one hospital.',
  contributedByPackId: 'ambulance',
  requiredPackIds: ['ambulance', 'traffic'],
  requiredProviderIds: [ambulanceSimProviderId, trafficSimProviderId],
  world: {
    startsAt: scenarioStart,
    mapCenter: geoPointFromLonLat(10.7522, 59.9139),
    environment: {
      city: 'Oslo',
      mode: 'tutorial',
    },
  },
  initialObjects: [
    createScenarioHospitalObject({
      id: 'facility:ous' as ObjectId,
      label: 'Oslo University Hospital',
      point: geoPointFromLonLat(10.7387, 59.9365),
      at: scenarioStart,
    }),
    createScenarioAmbulanceObject({
      id: 'amb:a12' as ObjectId,
      label: 'Ambulance A-12',
      point: geoPointFromLonLat(10.7387, 59.9365),
      equipment: ['defibrillator', 'ventilator'],
      at: scenarioStart,
    }),
    createScenarioIncidentObject({
      id: 'incident:77' as ObjectId,
      label: 'Incident 77',
      point: geoPointFromLonLat(10.7750, 59.9120),
      triage: 'red',
      at: scenarioStart,
    }),
  ],
  initialContexts: [],
  providerConfigs: {
    [ambulanceSimProviderId]: {},
    [trafficSimProviderId]: {},
  },
}) as ScenarioDefinition
