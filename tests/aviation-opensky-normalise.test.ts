import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { normaliseOpenSkyStates } from '../src/packs/aviation/sim/opensky/normalise.ts'
import { aircraftDomainDataSchema } from '../src/packs/aviation/model.ts'

const FIXTURE_PATH = new URL('./fixtures/opensky-states-all.json', import.meta.url)
const FIXED_NOW = '2026-01-01T00:00:00.000Z' as IsoTimestamp

const loadFixture = async (): Promise<unknown> =>
  JSON.parse(await readFile(FIXTURE_PATH, 'utf8'))

describe('normaliseOpenSkyStates', () => {
  it('produces canonical aircraft OperationalObjects with positions only', async () => {
    const raw = await loadFixture()
    const aircraft = normaliseOpenSkyStates(raw, { now: () => FIXED_NOW })
    expect(aircraft.length).toBe(2) // ghost row without position is dropped

    const sas = aircraft.find(object => object.id === 'aircraft:opensky:4ca1f3')
    expect(sas).toBeDefined()
    if (!sas) return
    expect(sas.kind).toBe('aircraft')
    expect(String(sas.domain)).toBe('aviation')
    expect(sas.label).toBe('SAS123')
    expect(sas.spatial.position?.point.coordinates.map(Number)).toEqual([10.7522, 59.9139])
    expect(sas.operational.status).toBe('active')
    expect(sas.operational.mode).toBe('live')
    expect(String(sas.provenance.adapterId)).toBe('aviation.opensky')
    expect(sas.provenance.externalId).toBe('4ca1f3')
    const data = aircraftDomainDataSchema.parse(sas.domainData)
    expect(data.source).toBe('opensky')
    expect(data.callsign).toBe('SAS123')
    expect(data.altBaroM).toBe(9144)
    expect(data.onGround).toBe(false)
    expect(data.squawk).toBe('1234')

    const ground = aircraft.find(object => object.id === 'aircraft:opensky:4ca200')
    expect(ground).toBeDefined()
    if (!ground) return
    expect(ground.operational.status).toBe('idle')
    const groundData = aircraftDomainDataSchema.parse(ground.domainData)
    expect(groundData.onGround).toBe(true)
    expect(groundData.callsign).toBe('WIF456')
  })

  it('tolerates an empty states payload', () => {
    const out = normaliseOpenSkyStates({ time: 0, states: null }, { now: () => FIXED_NOW })
    expect(out).toEqual([])
  })
})
