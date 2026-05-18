import type { ActorId, IsoTimestamp, ObjectId, OperationalObject, ScenarioDefinition } from '../core/model/index.ts'
import { confirmedFact, estimatedFact, geoPointFromLonLat, scenarioDefinitionSchema, unknownFact } from '../core/model/index.ts'
import type { AmbulanceDomainData, IncidentDomainData } from '../packs/ambulance/model.ts'
import {
  createScenarioAmbulanceObject,
  createScenarioHospitalObject,
  createScenarioIncidentObject,
} from '../packs/ambulance/sim/object-state.ts'

const scenarioStart = '2026-01-01T09:00:00.000Z' as IsoTimestamp

const addSeconds = (seconds: number): IsoTimestamp =>
  new Date(Date.parse(scenarioStart) + seconds * 1000).toISOString() as IsoTimestamp

const withRevision = (object: OperationalObject, revision: number, at: IsoTimestamp): OperationalObject => ({
  ...object,
  revision,
  timestamps: {
    ...object.timestamps,
    updatedAt: at,
  },
})

const withVictimCount = (
  object: OperationalObject,
  victimCount: number | 'unknown',
  at: IsoTimestamp,
  revision: number,
): OperationalObject => {
  const data = object.domainData as IncidentDomainData
  return withRevision({
    ...object,
    domainData: {
      ...data,
      victims: {
        ...data.victims,
        count: victimCount === 'unknown'
          ? unknownFact(at, 'scenario')
          : estimatedFact(victimCount, at, 'scenario', 0.84),
      },
    } satisfies IncidentDomainData,
  }, revision, at)
}

const withAmbulanceLoad = (
  object: OperationalObject,
  config: {
    readonly patientsOnBoard: number
    readonly targetId?: ObjectId
    readonly status: string
    readonly at: IsoTimestamp
  },
): OperationalObject => {
  const data = object.domainData as AmbulanceDomainData
  return {
    ...withRevision(object, 1, config.at),
    operational: {
      ...object.operational,
      status: config.status,
      ...(config.targetId === undefined ? {} : { intent: 'transport_patient' }),
    },
    ...(config.targetId === undefined
      ? {}
      : {
          tasking: {
            currentTaskId: config.targetId,
            assignedBy: 'actor:dispatcher' as ActorId,
            assignedAt: config.at,
          },
        }),
    domainData: {
      ...data,
      transport: {
        ...data.transport!,
        patientsOnBoard: confirmedFact(config.patientsOnBoard, config.at, 'scenario', 1),
      },
    } satisfies AmbulanceDomainData,
  }
}

const hospitals = [
  createScenarioHospitalObject({
    id: 'facility:ous' as ObjectId,
    label: 'Oslo University Hospital',
    point: geoPointFromLonLat(10.7387, 59.9365),
    traumaBedsTotal: 4,
    traumaBedsAvailable: 2,
    at: scenarioStart,
  }),
  createScenarioHospitalObject({
    id: 'facility:lovisenberg' as ObjectId,
    label: 'Lovisenberg Hospital',
    point: geoPointFromLonLat(10.7519, 59.9326),
    traumaBedsTotal: 5,
    traumaBedsAvailable: 4,
    at: scenarioStart,
  }),
  createScenarioHospitalObject({
    id: 'facility:aker' as ObjectId,
    label: 'Aker Emergency Clinic',
    point: geoPointFromLonLat(10.8001, 59.9391),
    traumaBedsTotal: 6,
    traumaBedsAvailable: 5,
    at: scenarioStart,
  }),
] as const

const ambulances = [
  createScenarioAmbulanceObject({
    id: 'amb:a12' as ObjectId,
    label: 'Ambulance A-12',
    point: geoPointFromLonLat(10.7387, 59.9365),
    equipment: ['defibrillator', 'ventilator'],
    at: scenarioStart,
  }),
  withAmbulanceLoad(createScenarioAmbulanceObject({
    id: 'amb:a21' as ObjectId,
    label: 'Ambulance A-21',
    point: geoPointFromLonLat(10.7707, 59.9146),
    equipment: ['defibrillator'],
    at: scenarioStart,
  }), {
    patientsOnBoard: 1,
    targetId: 'facility:ous' as ObjectId,
    status: 'transporting',
    at: scenarioStart,
  }),
  withAmbulanceLoad(createScenarioAmbulanceObject({
    id: 'amb:a34' as ObjectId,
    label: 'Ambulance A-34',
    point: geoPointFromLonLat(10.7828, 59.9237),
    equipment: ['defibrillator'],
    at: scenarioStart,
  }), {
    patientsOnBoard: 1,
    targetId: 'facility:lovisenberg' as ObjectId,
    status: 'transporting',
    at: scenarioStart,
  }),
] as const

const resolvedIncident = withRevision({
  ...createScenarioIncidentObject({
    id: 'incident:storo-cleared' as ObjectId,
    label: 'Storo collision',
    point: geoPointFromLonLat(10.7874, 59.9460),
    triage: 'yellow',
    victimCount: 0,
    at: scenarioStart,
  }),
  lifecycle: 'resolved',
  operational: {
    status: 'resolved',
    priority: 'normal',
    mode: 'simulated',
  },
}, 1, scenarioStart)

const partialIncident = createScenarioIncidentObject({
  id: 'incident:torshov-partial' as ObjectId,
  label: 'Torshov bicycle crash',
  point: geoPointFromLonLat(10.7750, 59.9328),
  triage: 'yellow',
  victimCount: 'unknown',
  at: scenarioStart,
})

const unattendedIncident = createScenarioIncidentObject({
  id: 'incident:gronland-unattended' as ObjectId,
  label: 'Grønland multi-car crash',
  point: geoPointFromLonLat(10.7628, 59.9124),
  triage: 'red',
  victimCount: 3,
  at: scenarioStart,
})

const majorstuenIncident = createScenarioIncidentObject({
  id: 'incident:majorstuen-tram' as ObjectId,
  label: 'Majorstuen tram stop fall',
  point: geoPointFromLonLat(10.7146, 59.9292),
  triage: 'yellow',
  victimCount: 'unknown',
  at: addSeconds(120),
})

const ringThreeIncident = createScenarioIncidentObject({
  id: 'incident:ring3-pileup' as ObjectId,
  label: 'Ring 3 pile-up',
  point: geoPointFromLonLat(10.8061, 59.9362),
  triage: 'red',
  victimCount: 4,
  at: addSeconds(300),
})

export const osloAmbulanceTutorialScenario = scenarioDefinitionSchema.parse({
  id: 'oslo-ambulance-tutorial',
  schemaVersion: 1,
  title: 'Oslo ambulance tutorial',
  description: 'A timed Oslo ambulance dispatch scenario with existing transports, unresolved incidents, and tutorial guidance.',
  packs: ['ambulance', 'traffic'],
  providerOverrides: {},
  world: {
    startsAt: scenarioStart,
    mapCenter: geoPointFromLonLat(10.7522, 59.9139),
    environment: {
      city: 'Oslo',
      mode: 'tutorial',
    },
  },
  initialObjects: [
    ...hospitals,
    ...ambulances,
    resolvedIncident,
    partialIncident,
    unattendedIncident,
  ],
  initialContexts: [],
  providerConfigs: {
    ambulance: {},
    traffic: {},
  },
  script: {
    steps: [
      {
        id: 'scenario-started',
        at: { kind: 'after_scenario_start', seconds: 0 },
        actions: [
          {
            type: 'show_guidance',
            guidance: {
              id: 'welcome',
              title: 'Dispatch overview',
              message: 'Oslo is already active: one incident is resolved, one is partly handled, and one red incident is unattended. Select an available ambulance, then click a valid incident or hospital target.',
              objectIds: ['amb:a12', 'incident:gronland-unattended'],
              dismissible: true,
            },
          },
          {
            type: 'highlight_objects',
            objectIds: ['amb:a12', 'incident:gronland-unattended'],
          },
        ],
      },
      {
        id: 'partial-incident-clarified',
        at: { kind: 'after_scenario_start', seconds: 45 },
        actions: [
          {
            type: 'upsert_object',
            object: withVictimCount(partialIncident, 1, addSeconds(45), 1),
          },
          {
            type: 'show_guidance',
            guidance: {
              id: 'partial-clarified',
              title: 'New incident information',
              message: 'Radio update: the Torshov bicycle crash has one remaining patient after the first ambulance departed with another patient.',
              objectIds: ['incident:torshov-partial'],
              dismissible: true,
            },
          },
          {
            type: 'highlight_objects',
            objectIds: ['incident:torshov-partial'],
          },
        ],
      },
      {
        id: 'majorstuen-created',
        at: { kind: 'after_scenario_start', seconds: 120 },
        actions: [
          {
            type: 'upsert_object',
            object: majorstuenIncident,
          },
          {
            type: 'show_guidance',
            guidance: {
              id: 'majorstuen-created',
              title: 'New incident',
              message: 'A fall at Majorstuen tram stop has been reported. Victim count is unknown; dispatch decisions may need to account for uncertainty.',
              objectIds: ['incident:majorstuen-tram'],
              dismissible: true,
            },
          },
          {
            type: 'highlight_objects',
            objectIds: ['incident:majorstuen-tram'],
          },
        ],
      },
      {
        id: 'majorstuen-clarified',
        at: { kind: 'after_scenario_start', seconds: 165 },
        actions: [
          {
            type: 'upsert_object',
            object: withVictimCount(majorstuenIncident, 2, addSeconds(165), 1),
          },
          {
            type: 'show_guidance',
            guidance: {
              id: 'majorstuen-clarified',
              title: 'Victim count updated',
              message: 'Bystander report now estimates two patients at Majorstuen. Watch how the incident status changes as resources are assigned.',
              objectIds: ['incident:majorstuen-tram'],
              dismissible: true,
            },
          },
        ],
      },
      {
        id: 'ring-three-created',
        at: { kind: 'after_scenario_start', seconds: 300 },
        actions: [
          {
            type: 'upsert_object',
            object: ringThreeIncident,
          },
          {
            type: 'show_guidance',
            guidance: {
              id: 'ring-three-created',
              title: 'Escalation',
              message: 'A Ring 3 pile-up has four reported victims. This is deliberately too much for one ambulance and should force prioritization.',
              objectIds: ['incident:ring3-pileup'],
              dismissible: true,
            },
          },
          {
            type: 'highlight_objects',
            objectIds: ['incident:ring3-pileup'],
          },
        ],
      },
      {
        id: 'gronland-revised',
        at: { kind: 'after_scenario_start', seconds: 360 },
        actions: [
          {
            type: 'upsert_object',
            object: withVictimCount(unattendedIncident, 2, addSeconds(360), 1),
          },
          {
            type: 'show_guidance',
            guidance: {
              id: 'gronland-revised',
              title: 'Assessment revised',
              message: 'Police update: the Grønland incident victim estimate has been revised from three to two. Scenario data can change as reports improve.',
              objectIds: ['incident:gronland-unattended'],
              dismissible: true,
            },
          },
        ],
      },
    ],
  },
}) as ScenarioDefinition
