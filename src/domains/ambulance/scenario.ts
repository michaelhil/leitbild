import type { GeoJsonPoint, ObjectId } from '../../core/model/index.ts'
import { geoPointFromLonLat } from '../../core/model/index.ts'

export interface AmbulanceSeed {
  readonly id: ObjectId
  readonly label: string
  readonly position: GeoJsonPoint
  readonly equipment: ReadonlyArray<string>
}

export interface IncidentSeed {
  readonly id: ObjectId
  readonly label: string
  readonly position: GeoJsonPoint
  readonly triage: 'green' | 'yellow' | 'red'
  readonly patientCount: number
}

export interface FacilitySeed {
  readonly id: ObjectId
  readonly label: string
  readonly position: GeoJsonPoint
  readonly facilityType: 'hospital' | 'station'
}

export interface AmbulanceScenario {
  readonly ambulances: ReadonlyArray<AmbulanceSeed>
  readonly incidents: ReadonlyArray<IncidentSeed>
  readonly facilities: ReadonlyArray<FacilitySeed>
}

export const createOsloAmbulanceScenario = (): AmbulanceScenario => ({
  ambulances: [
    {
      id: 'amb:a12' as ObjectId,
      label: 'Ambulance A-12',
      position: geoPointFromLonLat(10.7387, 59.9365),
      equipment: ['defibrillator', 'ventilator'],
    },
  ],
  incidents: [
    {
      id: 'incident:77' as ObjectId,
      label: 'Incident 77',
      position: geoPointFromLonLat(10.7750, 59.9120),
      triage: 'red',
      patientCount: 1,
    },
  ],
  facilities: [
    {
      id: 'facility:ous' as ObjectId,
      label: 'Oslo University Hospital',
      position: geoPointFromLonLat(10.7387, 59.9365),
      facilityType: 'hospital',
    },
  ],
})
