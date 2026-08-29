import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { aircraftPackDataSchema } from '../src/packs/aviation/model.ts'
import { NORWAY_BBOX } from '../src/packs/aviation/sim/vatsim/constants.ts'
import { normaliseVatsimData } from '../src/packs/aviation/sim/vatsim/normalise.ts'

const FIXTURE = new URL('./fixtures/vatsim-data-sample.json', import.meta.url)
const FIXED_NOW = '2026-01-01T10:00:00.000Z' as IsoTimestamp

const loadFixture = async (): Promise<unknown> => JSON.parse(await readFile(FIXTURE, 'utf8'))

describe('normaliseVatsimData', () => {
  it('emits canonical aircraft objects, converting ft → m and kt → m/s', async () => {
    const raw = await loadFixture()
    const aircraft = normaliseVatsimData(raw, { bbox: NORWAY_BBOX, now: () => FIXED_NOW })
    expect(aircraft.length).toBe(2) // JFK aircraft outside Norway bbox is dropped

    const sas = aircraft.find(object => object.id === 'aircraft:vatsim:1234567')
    expect(sas).toBeDefined()
    if (!sas) return
    expect(String(sas.provenance.adapterId)).toBe('aviation.vatsim')
    expect(sas.provenance.externalId).toBe('1234567')
    const data = aircraftPackDataSchema.parse(sas.packData)
    expect(data.source).toBe('vatsim')
    expect(data.callsign).toBe('SAS321')
    // 32000 ft × 0.3048 = 9753.6 m
    expect(data.altBaroM).toBeCloseTo(9753.6, 1)
    // 470 kt × 0.514444 ≈ 241.79 m/s
    expect(data.velocityMps).toBeCloseTo(241.79, 1)
    expect(data.flightPlan?.departure).toBe('ENGM')
    expect(data.flightPlan?.arrival).toBe('EGLL')
    expect(data.flightPlan?.aircraftType).toBe('B738')

    const ground = aircraft.find(object => object.id === 'aircraft:vatsim:7654321')
    expect(ground).toBeDefined()
    if (!ground) return
    const groundData = aircraftPackDataSchema.parse(ground.packData)
    expect(groundData.onGround).toBe(true)
    expect(ground.operational.status).toBe('idle')
    expect(groundData.flightPlan).toBeNull()
  })

  it('returns all pilots when no bbox is provided', async () => {
    const raw = await loadFixture()
    const all = normaliseVatsimData(raw, { now: () => FIXED_NOW })
    expect(all.length).toBe(3)
  })

  it('tolerates an empty pilots list', () => {
    const out = normaliseVatsimData({ pilots: [] }, { now: () => FIXED_NOW })
    expect(out).toEqual([])
  })
})
