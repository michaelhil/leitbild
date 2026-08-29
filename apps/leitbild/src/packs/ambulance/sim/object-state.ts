import type { CommandEnvelope, GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject, TelemetryState } from '../../../core/model/index.ts'
import { confirmedFact, estimatedFact, meters, unknownFact } from '../../../core/model/index.ts'
import type { AmbulancePackData, HospitalPackData, IncidentPackData, InjurySummary } from '../model.ts'
import { ambulanceSimAdapterId, ambulanceSimPackId } from './constants.ts'

const makeTelemetry = (at: IsoTimestamp, heartRate: number, spo2: number): TelemetryState => ({
  signals: {
    heartRate: {
      signalId: 'heartRate',
      label: 'Heart rate',
      unit: 'bpm',
      latest: heartRate,
      samples: [{ at, value: heartRate }],
      severity: heartRate > 120 ? 'warning' : 'normal',
    },
    spo2: {
      signalId: 'spo2',
      label: 'SpO2',
      unit: '%',
      latest: spo2,
      samples: [{ at, value: spo2 }],
      severity: spo2 < 92 ? 'critical' : spo2 < 95 ? 'warning' : 'normal',
    },
  },
})

const makeAmbulancePackData = (equipment: ReadonlyArray<string>, at: IsoTimestamp): AmbulancePackData => ({
  type: 'ambulance',
  schemaVersion: 1,
  capabilities: [
    'advanced_life_support',
    'oxygen',
    'stretcher',
    ...(equipment.includes('defibrillator') ? ['defibrillator' as const] : []),
    ...(equipment.includes('ventilator') ? ['ventilator' as const] : []),
  ],
  crew: {
    status: 'ready',
    level: confirmedFact('advanced', at, 'scenario', 1),
    availableSeats: confirmedFact(1, at, 'scenario', 1),
  },
  transport: {
    patientCapacity: confirmedFact(1, at, 'scenario', 1),
    patientsOnBoard: confirmedFact(0, at, 'scenario', 1),
  },
})

const makeIncidentPackData = (
  triage: 'green' | 'yellow' | 'red',
  at: IsoTimestamp,
  config?: {
    readonly victimCount?: number | 'unknown'
    readonly assignedAmbulanceId?: ObjectId
  },
): IncidentPackData => ({
  type: 'incident',
  schemaVersion: 1,
  triage: confirmedFact(triage, at, 'scenario', 1),
  victims: {
    count: config?.victimCount === undefined || config.victimCount === 'unknown'
      ? unknownFact(at, 'scenario')
      : confirmedFact(config.victimCount, at, 'scenario', 1),
    injuries: unknownFact(at, 'scenario'),
    entrapment: unknownFact(at, 'scenario'),
  },
  hazards: unknownFact(at, 'scenario'),
  ...(config?.assignedAmbulanceId ? { assignedAmbulanceId: config.assignedAmbulanceId } : {}),
})

const makeHospitalPackData = (
  at: IsoTimestamp,
  config?: {
    readonly traumaBedsTotal?: number
    readonly traumaBedsAvailable?: number
  },
): HospitalPackData => ({
  type: 'hospital',
  schemaVersion: 1,
  emergencyDepartment: {
    traumaBedsTotal: confirmedFact(config?.traumaBedsTotal ?? 3, at, 'scenario', 1),
    traumaBedsAvailable: confirmedFact(config?.traumaBedsAvailable ?? config?.traumaBedsTotal ?? 3, at, 'scenario', 1),
    ambulanceBaysAvailable: confirmedFact(2, at, 'scenario', 1),
    patientsReceived: confirmedFact(0, at, 'scenario', 1),
    diversionStatus: confirmedFact('open', at, 'scenario', 1),
  },
  capabilities: ['trauma_center', 'stroke_unit', 'cardiac_catheterization'],
})

const makeEstimatedInjuries = (): InjurySummary[] => [
  { category: 'trauma', severity: 'critical', count: 1 },
  { category: 'respiratory', severity: 'serious', count: 1 },
]

const incidentDataOf = (object: OperationalObject): IncidentPackData | null => {
  const data = object.packData
  return typeof data === 'object'
    && data !== null
    && (data as { readonly type?: unknown }).type === 'incident'
    && (data as { readonly schemaVersion?: unknown }).schemaVersion === 1
    ? data as IncidentPackData
    : null
}

const hospitalDataOf = (object: OperationalObject): HospitalPackData | null => {
  const data = object.packData
  return typeof data === 'object'
    && data !== null
    && (data as { readonly type?: unknown }).type === 'hospital'
    && (data as { readonly schemaVersion?: unknown }).schemaVersion === 1
    ? data as HospitalPackData
    : null
}

export const revealIncidentDetails = (object: OperationalObject, at: IsoTimestamp): OperationalObject | null => {
  const data = incidentDataOf(object)
  if (!data || data.victims.count.state !== 'unknown') return null
  return {
    ...object,
    revision: object.revision + 1,
    packData: {
      ...data,
      victims: {
        count: estimatedFact(2, at, 'simulation', 0.72),
        injuries: estimatedFact(makeEstimatedInjuries(), at, 'simulation', 0.68),
        entrapment: estimatedFact(false, at, 'simulation', 0.61),
      },
      hazards: estimatedFact(['traffic obstruction', 'possible fuel spill'], at, 'simulation', 0.55),
    } satisfies IncidentPackData,
    provenance: {
      source: 'simulator',
      adapterId: ambulanceSimAdapterId,
      externalId: object.id,
    },
    timestamps: {
      ...object.timestamps,
      updatedAt: at,
    },
  }
}

export const updateHospitalCapacity = (object: OperationalObject, at: IsoTimestamp): OperationalObject | null => {
  const data = hospitalDataOf(object)
  if (!data || data.emergencyDepartment.ambulanceBaysAvailable.state !== 'confirmed') return null
  if (data.emergencyDepartment.ambulanceBaysAvailable.value === 1) return null
  return {
    ...object,
    revision: object.revision + 1,
    packData: {
      ...data,
      emergencyDepartment: {
        ...data.emergencyDepartment,
        ambulanceBaysAvailable: confirmedFact(1, at, 'simulation', 1),
        diversionStatus: confirmedFact('limited', at, 'simulation', 1),
      },
    } satisfies HospitalPackData,
    provenance: {
      source: 'simulator',
      adapterId: ambulanceSimAdapterId,
      externalId: object.id,
    },
    timestamps: {
      ...object.timestamps,
      updatedAt: at,
    },
  }
}

export const createScenarioAmbulanceObject = (config: {
  readonly id: ObjectId
  readonly label: string
  readonly point: GeoJsonPoint
  readonly equipment: ReadonlyArray<string>
  readonly at: IsoTimestamp
}): OperationalObject => ({
  id: config.id,
  kind: 'mobile_entity',
  packId: ambulanceSimPackId,
  label: config.label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point: config.point,
      headingDeg: 0,
      speedMps: 0,
      accuracyM: meters(8),
      observedAt: config.at,
      staleAfterMs: 5_000,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: 'available',
    priority: 'normal',
    mode: 'simulated',
  },
  alerts: [],
  communication: {
    state: 'connected',
    lastContactAt: config.at,
  },
  provenance: {
    source: 'simulator',
    adapterId: ambulanceSimAdapterId,
    externalId: config.id,
  },
  timestamps: {
    createdAt: config.at,
    updatedAt: config.at,
  },
  packData: {
    ...makeAmbulancePackData(config.equipment, config.at),
  } satisfies AmbulancePackData,
})

export const createScenarioIncidentObject = (config: {
  readonly id: ObjectId
  readonly label: string
  readonly point: GeoJsonPoint
  readonly triage: 'green' | 'yellow' | 'red'
  readonly victimCount?: number | 'unknown'
  readonly assignedAmbulanceId?: ObjectId
  readonly at: IsoTimestamp
}): OperationalObject => ({
  id: config.id,
  kind: 'incident',
  packId: ambulanceSimPackId,
  label: config.label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point: config.point,
      accuracyM: meters(5),
      observedAt: config.at,
      staleAfterMs: 60_000,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: 'open',
    priority: config.triage === 'red' ? 'critical' : config.triage === 'yellow' ? 'high' : 'normal',
    mode: 'simulated',
  },
  telemetry: makeTelemetry(config.at, config.triage === 'red' ? 122 : 98, config.triage === 'red' ? 91 : 96),
  alerts: config.triage === 'red'
    ? [{
        id: `${config.id}:triage`,
        kind: 'triage_red',
        severity: 'critical',
        message: 'Red triage incident requires immediate dispatch',
        raisedAt: config.at,
        acknowledged: false,
      }]
    : [],
  provenance: {
    source: 'simulator',
    adapterId: ambulanceSimAdapterId,
    externalId: config.id,
  },
  timestamps: {
    createdAt: config.at,
    updatedAt: config.at,
  },
  packData: {
    ...makeIncidentPackData(config.triage, config.at, {
      ...(config.victimCount === undefined ? {} : { victimCount: config.victimCount }),
      ...(config.assignedAmbulanceId === undefined ? {} : { assignedAmbulanceId: config.assignedAmbulanceId }),
    }),
  } satisfies IncidentPackData,
})

export const createScenarioHospitalObject = (config: {
  readonly id: ObjectId
  readonly label: string
  readonly point: GeoJsonPoint
  readonly traumaBedsTotal?: number
  readonly traumaBedsAvailable?: number
  readonly at: IsoTimestamp
}): OperationalObject => ({
  id: config.id,
  kind: 'facility',
  packId: ambulanceSimPackId,
  label: config.label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point: config.point,
      observedAt: config.at,
      staleAfterMs: 600_000,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: 'hospital',
    priority: 'normal',
    mode: 'simulated',
  },
  alerts: [],
  provenance: {
    source: 'simulator',
    adapterId: ambulanceSimAdapterId,
    externalId: config.id,
  },
  timestamps: {
    createdAt: config.at,
    updatedAt: config.at,
  },
  packData: {
    ...makeHospitalPackData(config.at, {
      ...(config.traumaBedsTotal === undefined ? {} : { traumaBedsTotal: config.traumaBedsTotal }),
      ...(config.traumaBedsAvailable === undefined ? {} : { traumaBedsAvailable: config.traumaBedsAvailable }),
    }),
  } satisfies HospitalPackData,
})

export const createHospitalObject = (id: ObjectId, label: string, point: GeoJsonPoint, at: IsoTimestamp, causedByCommandId: CommandEnvelope['id']): OperationalObject => ({
  id,
  kind: 'facility',
  packId: ambulanceSimPackId,
  label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point,
      observedAt: at,
      staleAfterMs: 600_000,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: 'hospital',
    priority: 'normal',
    mode: 'simulated',
  },
  alerts: [],
  provenance: {
    source: 'operator',
    adapterId: ambulanceSimAdapterId,
    externalId: id,
    causedByCommandId,
  },
  timestamps: {
    createdAt: at,
    updatedAt: at,
  },
  packData: {
    ...makeHospitalPackData(at),
  } satisfies HospitalPackData,
})

export const createAddedAmbulanceObject = (id: ObjectId, label: string, point: GeoJsonPoint, at: IsoTimestamp, causedByCommandId: CommandEnvelope['id']): OperationalObject => ({
  id,
  kind: 'mobile_entity',
  packId: ambulanceSimPackId,
  label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point,
      headingDeg: 0,
      speedMps: 0,
      accuracyM: meters(8),
      observedAt: at,
      staleAfterMs: 5_000,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: 'available',
    priority: 'normal',
    mode: 'simulated',
  },
  alerts: [],
  communication: {
    state: 'connected',
    lastContactAt: at,
  },
  provenance: {
    source: 'operator',
    adapterId: ambulanceSimAdapterId,
    externalId: id,
    causedByCommandId,
  },
  timestamps: {
    createdAt: at,
    updatedAt: at,
  },
  packData: {
    ...makeAmbulancePackData(['defibrillator', 'oxygen', 'stretcher'], at),
  } satisfies AmbulancePackData,
})

export const createAddedIncidentObject = (id: ObjectId, label: string, point: GeoJsonPoint, at: IsoTimestamp, causedByCommandId: CommandEnvelope['id']): OperationalObject => ({
  id,
  kind: 'incident',
  packId: ambulanceSimPackId,
  label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point,
      accuracyM: meters(5),
      observedAt: at,
      staleAfterMs: 60_000,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: 'open',
    priority: 'critical',
    mode: 'simulated',
  },
  telemetry: makeTelemetry(at, 122, 91),
  alerts: [{
    id: `${id}:triage`,
    kind: 'triage_red',
    severity: 'critical',
    message: 'Red triage incident requires immediate dispatch',
    raisedAt: at,
    acknowledged: false,
  }],
  provenance: {
    source: 'operator',
    adapterId: ambulanceSimAdapterId,
    externalId: id,
    causedByCommandId,
  },
  timestamps: {
    createdAt: at,
    updatedAt: at,
  },
  packData: {
    ...makeIncidentPackData('red', at),
  } satisfies IncidentPackData,
})
