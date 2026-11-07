import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileProcessPlant } from '../src/packs/process-plant/plant-compiler.ts'
import { ld01UnitArtifactEnv, resolveLd01UnitArtifact } from '../src/packs/process-plant/engine/artifact.ts'
import { connectNativeProcessPlantEngine, type NativeAdvanceReceipt, type NativeProcessPlantEngine } from '../src/packs/process-plant/engine/native-engine.ts'
import type { VariablePath } from '../src/packs/process-plant/graph/index.ts'

// NOT-EVIDENCE, ignored by default: the native engine against the real `ld01-unit` of the artifact
// LD01_UNIT_ARTIFACT names (a local r4b artifact, never production). It runs only when LD01_UNIT_REAL_RECEIPTS
// names a new directory for its receipts too: `LD01_UNIT_ARTIFACT=<dir> LD01_UNIT_REAL_RECEIPTS=<new dir> bun test
// tests/process-plant-ld01-real-unit.test.ts`. Minutes of child CPU.
const artifactDirectory = process.env[ld01UnitArtifactEnv]
const receipts = process.env.LD01_UNIT_REAL_RECEIPTS
const enabled = artifactDirectory !== undefined && receipts !== undefined
const engines: NativeProcessPlantEngine[] = []
const recorded: Record<string, unknown> = {}
afterAll(async () => {
  for (const engine of engines.splice(0)) await engine.close()
  if (enabled) writeFileSync(join(receipts, 'real-unit-receipts.json'), `${JSON.stringify({ basis: 'NOT-EVIDENCE: the World engine port on the real ld01-unit', artifact: artifactDirectory, ...recorded }, null, 1)}\n`)
})

const bits = (values: Float64Array): string => Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('hex')

describe.skipIf(!enabled)('NOT-EVIDENCE: the LD-01 engine on the real ld01-unit', () => {
  const resolution = enabled ? resolveLd01UnitArtifact() : null
  const artifact = resolution?.ok === true ? resolution.artifact : null
  const plant = () => compileProcessPlant({ id: 'plant:ld01-real', model: { ref: 'process-plant.ld01', parameters: {} }, operatingPoint: { ref: 'process-plant.ld01.s3-settled' }, automation: { ref: 'process-plant.ld01.kernel' } })
  const connect = async (restored?: Parameters<typeof connectNativeProcessPlantEngine>[0]['restored']) => {
    if (artifact === null) throw new Error(`the artifact is not usable: ${resolution !== null && !resolution.ok ? resolution.reason : 'none'}`)
    const startedAt = performance.now()
    const engine = await connectNativeProcessPlantEngine({ plant: plant(), tagMap: artifact.tagMap, load: artifact.load, artifactSha256: artifact.manifestSha256, command: [artifact.binary], ...(restored === undefined ? {} : { restored }) })
    engines.push(engine)
    return { engine, wallS: (performance.now() - startedAt) / 1_000 }
  }
  const run = async (engine: NativeProcessPlantEngine, seconds: number): Promise<NativeAdvanceReceipt[]> => {
    const frames: NativeAdvanceReceipt[] = []
    for (let second = 0; second < seconds; second += 1) frames.push(await engine.advance(1_000))
    return frames
  }
  const costOf = (frames: ReadonlyArray<NativeAdvanceReceipt>) => ({
    exchanges: frames.length,
    wallS: frames.reduce((sum, frame) => sum + frame.cost.wallS, 0),
    cpuS: frames.reduce((sum, frame) => sum + frame.cost.cpuS, 0),
    worstWallS: Math.max(...frames.map(frame => frame.cost.wallS)),
  })

  test('LOAD succeeds and the tag map binds every channel; 5 s of 1 s exchanges give finite frames', async () => {
    mkdirSync(receipts!, { recursive: true })
    const { engine, wallS } = await connect()
    const snapshot = engine.runtime.snapshot()
    expect(snapshot.variables.length).toBe(plant().graph.variables.length)
    const frames = await run(engine, 5)
    // Only a depletion estimate may be no number, and then only while its DC group is not discharging: none is here.
    const estimates = Object.values(artifact!.tagMap.channels).filter(entry => typeof entry === 'string' && entry.endsWith('.DEPLETION')).length
    for (const frame of frames) expect([...frame.frame!.values].filter(value => !Number.isFinite(value)).length).toBe(estimates)
    expect(engine.runtime.elapsedMs()).toBeCloseTo(5_100, 6)
    recorded.load = { connectWallS: wallS, connectCost: engine.connectCost, variables: snapshot.variables.length, channels: frames[0]!.frame!.values.length, advance: costOf(frames) }
    recorded.readings = Object.fromEntries(['PZR.pressure', 'PZR.collapsedLevel', 'CORE.releasedPower', 'TG.terminalPower', 'PUMP.A1.speed', 'SG.A.PRIMARY.pressure']
      .map(path => [path, engine.runtime.readVariable(path as VariablePath)]))
  }, 300_000)

  test('a turbine trip written now applies at the unit time of the next exchange: acquired by protection, breaker open, rods seated', async () => {
    const { engine } = await connect()
    await run(engine, 1)
    const writtenAtMs = engine.runtime.elapsedMs()
    const before = { terminalPowerMw: engine.runtime.readVariable('TG.terminalPower' as VariablePath), releasedPowerMw: engine.runtime.readVariable('CORE.releasedPower' as VariablePath) }
    engine.runtime.writeCommand({ type: 'setVariable', path: 'TG.turbineTrip' as VariablePath, value: true })
    const frames = await run(engine, 4)
    const events = frames.map(frame => frame.frame!.events as { readonly instants?: ReadonlyArray<readonly [number, string, ReadonlyArray<string>]>; readonly seats?: ReadonlyArray<readonly [string, number]> } | null)
    const applied = events[0]?.instants?.find(instant => instant[2].includes('command TurbineTripAcquired'))
    // The command's instant is the unit time the exchange started at: the time it was written.
    expect(applied?.[0]).toBeCloseTo(frames[0]!.frame!.t - 1, 9)
    expect(engine.runtime.readVariable('TG.breakerClosed' as VariablePath)).toBe(false)
    // The acquired path: the turbine-state report latches the kernel's TG.TRIP function in its divisions.
    expect(engine.runtime.readVariable('PROTECTION.latched.LD01.PROT.TG.TRIP' as VariablePath)).toBeGreaterThanOrEqual(2)
    // Every rod cluster the graph reads seats.
    expect(events.flatMap(entry => entry?.seats ?? []).length).toBe(plant().graph.variables.filter(variable => String(variable.path).startsWith('CORE.rod.')).length)
    const after = { terminalPowerMw: engine.runtime.readVariable('TG.terminalPower' as VariablePath), releasedPowerMw: engine.runtime.readVariable('CORE.releasedPower' as VariablePath) }
    expect(after.releasedPowerMw as number).toBeLessThan((before.releasedPowerMw as number) / 2)
    recorded.turbineTrip = { writtenAtMs, appliedAtUnitS: applied?.[0], before, after, events, advance: costOf(frames) }
  }, 300_000)

  // A section declaring the governor and the DC groups (the ECA0 binding): their readings, and an operator's commands end to end.
  const declared = artifact?.tagMap.channels['TG.ADM_POS' as VariablePath] !== undefined
  test.skipIf(!declared)('reads ADM.POS and the DC groups; a DC command reaches its group; a refused request is logged and stops nothing', async () => {
    const { engine } = await connect()
    await run(engine, 1)
    const read = (path: string) => engine.runtime.readVariable(path as VariablePath)
    const position = read('TG.ADM_POS') as number
    expect(position).toBeGreaterThan(0)
    expect(position).toBeLessThanOrEqual(100)
    expect(read('TG.DC-I2-OUTPUT')).toBe(true)
    expect(read('TG.DC-I2-CHARGER')).toBe(true)
    expect(read('TG.DC-I2-LOAD-REQUESTED')).toBeGreaterThan(0)
    expect(read('TG.DC-I2-ENERGY')).toBeGreaterThan(0)
    expect(read('TG.DC-I2-DEPLETION')).toBeNaN()
    const electrical = (frames: ReadonlyArray<NativeAdvanceReceipt>): ReadonlyArray<string> =>
      frames.flatMap(frame => ((frame.frame!.events as { readonly electrical?: ReadonlyArray<readonly [number, string]> } | null)?.electrical ?? []).map(entry => entry[1]))
    const write = (path: string) => { engine.runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value: true }) }
    write('TG.dc.LD01.DC.I2.open')
    const opened = await run(engine, 2)
    expect(electrical(opened)).toContain('operator LD01.DC.I2 Open: accepted')
    expect(read('TG.DC-I2-OUTPUT')).toBe(false)
    expect(read('TG.DC-I2-LOAD-DELIVERED')).toBe(0)
    write('TG.dc.LD01.DC.I2.close')
    const closed = await run(engine, 2)
    expect(electrical(closed)).toContain('operator LD01.DC.I2 Close: accepted')
    expect(read('TG.DC-I2-OUTPUT')).toBe(true)
    // The AC.A unit incoming is closed, so the reserve's may not close: refused by its guard, logged, and the unit goes on.
    write('TG.incoming.AC.A.reserve.close')
    const refused = await run(engine, 1)
    expect(electrical(refused)).toContain('operator AC.A Reserve incoming Closed: rejected')
    expect(engine.failure()).toBeNull()
    recorded.operator = { position, opened: electrical(opened), closed: electrical(closed), refused: electrical(refused) }
  }, 300_000)

  test('snapshot, restore in a fresh child, then 30 s more in both: every frame bitwise equal', async () => {
    const { engine: source } = await connect()
    await run(source, 3)
    const checkpoint = await source.checkpoint()
    const { engine: copy, wallS } = await connect(checkpoint)
    expect(copy.runtime.elapsedMs()).toBe(source.runtime.elapsedMs())
    const [a, b] = [await run(source, 30), await run(copy, 30)]
    const differing = a.flatMap((frame, at) => bits(frame.frame!.values) === bits(b[at]!.frame!.values) && JSON.stringify(frame.frame!.events) === JSON.stringify(b[at]!.frame!.events) ? [] : [at])
    expect(differing).toEqual([])
    // A copy's later snapshots are the source's too: the futures are one.
    const [late, lateCopy] = [await source.checkpoint(), await copy.checkpoint()]
    expect(JSON.stringify(lateCopy.snapshot)).toBe(JSON.stringify(late.snapshot))
    recorded.restore = { restoreWallS: wallS, restoreCost: copy.connectCost, snapshotAtMs: copy.runtime.elapsedMs() - 30_000, frames: a.length, differing, sourceAdvance: costOf(a), copyAdvance: costOf(b), lastFrameSha256: new Bun.CryptoHasher('sha256').update(bits(a.at(-1)!.frame!.values)).digest('hex') }
  }, 600_000)
})
