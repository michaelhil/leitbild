import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileResolvedProcessPlant } from '../src/packs/process-plant/plant-compiler.ts'
import { ld01UnitAdvanceLimitS } from '../src/packs/process-plant/engine/child.ts'
import { connectNativeProcessPlantEngine, type NativeEngineFailure } from '../src/packs/process-plant/engine/native-engine.ts'
import { loadLd01UnitArtifact, resolveLd01UnitArtifact } from '../src/packs/process-plant/engine/artifact.ts'
import { processPlantEngineKindFor } from '../src/packs/process-plant/engine/port.ts'
import type { Ld01TagMap } from '../src/packs/process-plant/engine/tag-map.ts'
import type { VariablePath } from '../src/packs/process-plant/graph/index.ts'

// The native engine against the protocol double (tests/ld01-unit-double.ts), never the real kernel.
const double = [process.execPath, join(import.meta.dir, 'ld01-unit-double.ts')]
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const plant = compileResolvedProcessPlant({
  id: 'plant:ld01-test',
  modelRef: 'process-plant.ld01',
  operatingPointRef: 'process-plant.ld01.s3-settled',
  automationRef: 'process-plant.ld01.kernel',
  graph: {
    schemaVersion: 1,
    id: 'ld01.test',
    title: 'LD-01 engine test',
    timestep: { fixedStepMs: 100 },
    components: [{
      id: 'PROTECTION',
      kind: 'nativeProtectionSystem',
      label: 'Reactor protection',
      parameters: {
        readings: [
          { path: 'pressure', label: 'Pressurizer pressure', kind: 'state', discipline: 'thermal', quantity: 'pressure', unit: 'MPa' },
          { path: 'tripped', label: 'Division I1 tripped', kind: 'discrete', discipline: 'control', quantity: 'boolean', unit: 'boolean' },
        ],
        commands: [{ path: 'manualReactorTrip', label: 'Manual reactor trip', actuation: 'command' }],
      },
      metadata: { presentation: { momentary: ['manualReactorTrip'] } },
    }],
    connections: [],
    publishedVariables: ['PROTECTION.pressure', 'PROTECTION.tripped', 'PROTECTION.manualReactorTrip'],
  } as never,
  automationForGraph: () => ({}) as never,
})
const tagMap: Ld01TagMap = {
  channels: { ['PROTECTION.pressure' as VariablePath]: 'LD01.PZR.PRESSURE', ['PROTECTION.tripped' as VariablePath]: 'LD01.PROT.I1.TRIP' },
  commands: { ['PROTECTION.manualReactorTrip' as VariablePath]: { kind: 'ManualReactorTrip' } },
}
const artifactSha256 = 'a'.repeat(64)
const fixtureChannels = [
  { id: 'LD01.UNIT.TIME', unit: 's', value: 0, rate: 1 },
  { id: 'LD01.PZR.PRESSURE', unit: 'Pa', value: 15_000_000, rate: 1_000 },
  { id: 'LD01.PROT.I1.TRIP', unit: '1', value: 0, rate: 0, setBy: 'ManualReactorTrip' },
]

const fixtureLoad = async (fixture: Record<string, unknown>) => {
  const directory = await mkdtemp(join(tmpdir(), 'leitbild-ld01-engine-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const packet = join(directory, 'fixture.json')
  await writeFile(packet, JSON.stringify({ t0: 100, frame_s: 0.1, channels: fixtureChannels, ...fixture }))
  return {
    inputs: { packet, wiki_root: directory, wiki_commit: null, wiki_repository: null, ic: packet, pzr_control: packet, pzr_control_wiki: directory, elec: packet },
    state: packet,
    solver: { weights: 'declared', first_step: 'declared', stepping: 'free', water: 'if97', source_atol: 'derived' },
  } as const
}

const connect = async (fixture: Record<string, unknown> = {}, extra: Partial<Parameters<typeof connectNativeProcessPlantEngine>[0]> = {}) => {
  const load = extra.load ?? await fixtureLoad(fixture)
  const engine = await connectNativeProcessPlantEngine({ plant, tagMap, load, artifactSha256, command: double, ...extra })
  cleanups.push(async () => { await engine.close() })
  return engine
}

describe('the process-plant engine port', () => {
  test('dispatches on the Plant Model reference through a closed two-entry table', () => {
    expect(processPlantEngineKindFor('process-plant.pwr.reference')).toBe('ts')
    expect(processPlantEngineKindFor('process-plant.ld01')).toBe('native')
    expect(() => processPlantEngineKindFor('process-plant.other')).toThrow('process plant model process-plant.other has no engine')
  })
})

describe('the LD-01 native engine', () => {
  test('observes the first I&C frame at connect and each frame an ADVANCE returns', async () => {
    const engine = await connect()
    expect(engine.runtime.elapsedMs()).toBeCloseTo(100, 9)
    expect(engine.runtime.readVariable('PROTECTION.pressure' as VariablePath)).toBeCloseTo(15.0001, 12)
    const receipt = await engine.advance(1_000)
    expect(receipt.simulatedMs).toBeCloseTo(1_000, 9)
    expect(engine.runtime.elapsedMs()).toBeCloseTo(1_100, 9)
    expect(engine.runtime.readVariable('PROTECTION.pressure' as VariablePath)).toBeCloseTo(15.0011, 12)
    expect(engine.runtime.readVariableSnapshot('PROTECTION.pressure' as VariablePath)).toMatchObject({ unit: 'MPa', writable: false, published: true })
    expect(() => engine.runtime.tick(1_000)).toThrow('advances through its native engine')
    expect(() => engine.runtime.pwrTransientDiagnostics()).toThrow('does not answer them')
  })

  test('exchanges only on I&C frame instants, carrying the remainder: how a Run slices its time changes no frame', async () => {
    const [whole, sliced] = [await connect(), await connect()]
    const once = await whole.advance(1_000)
    expect((await sliced.advance(30)).frame).toBeNull()
    expect(sliced.runtime.advancedMs()).toBeCloseTo(130, 9)
    await sliced.advance(320)
    const last = await sliced.advance(650)
    expect(Object.is(last.frame!.t, once.frame!.t)).toBe(true)
    expect(Object.is(last.frame!.t, 1011 * 0.1)).toBe(true)
    expect([...last.frame!.values]).toEqual([...once.frame!.values])
  })

  test('sends a command at the unit time of the next exchange; writes only true to a command variable', async () => {
    const engine = await connect()
    expect(engine.runtime.readVariable('PROTECTION.tripped' as VariablePath)).toBe(false)
    expect(() => engine.runtime.writeCommand({ type: 'setVariable', path: 'PROTECTION.pressure' as VariablePath, value: 1 })).toThrow('only its kernel commands are writable')
    expect(() => engine.runtime.writeCommand({ type: 'setVariable', path: 'PROTECTION.manualReactorTrip' as VariablePath, value: false })).toThrow('sends nothing')
    engine.runtime.writeCommand({ type: 'setVariable', path: 'PROTECTION.manualReactorTrip' as VariablePath, value: true })
    expect(engine.runtime.readVariable('PROTECTION.manualReactorTrip' as VariablePath)).toBe(true)
    const receipt = await engine.advance(500)
    expect(receipt.frame!.events).toEqual({ applied: ['ManualReactorTrip'] })
    expect(engine.runtime.readVariable('PROTECTION.tripped' as VariablePath)).toBe(true)
    expect(engine.runtime.readVariable('PROTECTION.manualReactorTrip' as VariablePath)).toBe(false)
  })

  test('a snapshot restored in a fresh child continues bit for bit; a start state reproduces its first frame', async () => {
    const load = await fixtureLoad({})
    const source = await connect({}, { load })
    const fresh = source.persisted()
    expect(fresh.snapshot).toBeNull()
    await source.advance(1_000)
    source.runtime.writeCommand({ type: 'setVariable', path: 'PROTECTION.manualReactorTrip' as VariablePath, value: true })
    await source.advance(250)
    const checkpoint = await source.checkpoint()
    expect(checkpoint.snapshot).toMatchObject({ format: 'ld01-unit-snapshot' })
    const copy = await connect({}, { load, restored: checkpoint })
    expect(copy.runtime.elapsedMs()).toBe(source.runtime.elapsedMs())
    expect(copy.runtime.readVariable('PROTECTION.pressure' as VariablePath)).toBe(source.runtime.readVariable('PROTECTION.pressure' as VariablePath))
    const [a, b] = [await source.advance(2_000), await copy.advance(2_000)]
    expect([...b.frame!.values]).toEqual([...a.frame!.values])
    expect(copy.runtime.readVariable('PROTECTION.tripped' as VariablePath)).toBe(true)
    const restarted = await connect({}, { load, restored: fresh })
    expect(restarted.runtime.elapsedMs()).toBeCloseTo(100, 9)
    await expect(connect({}, { load, restored: { ...checkpoint, artifactSha256: 'b'.repeat(64) } })).rejects.toThrow('no migration')
  })

  test('a dead child fails the engine at its time: every pending and later request rejects, nothing restarts', async () => {
    const failures: NativeEngineFailure[] = []
    const engine = await connect({ dieAtS: 101 }, { onFailure: failure => { failures.push(failure) } })
    await expect(engine.advance(500)).resolves.toBeDefined()
    const dying = engine.advance(1_000)
    const queued = engine.checkpoint()
    const [died, waited] = await Promise.allSettled([dying, queued])
    expect(died.status === 'rejected' && String(died.reason)).toMatch(/LD-01 engine failed at t=0\.600 s: ld01-unit \(pid \d+\) was killed by SIGKILL/u)
    expect(waited.status === 'rejected' && String(waited.reason)).toContain('was killed by SIGKILL')
    await expect(engine.advance(1_000)).rejects.toThrow('was killed by SIGKILL')
    expect(() => engine.runtime.readVariable('PROTECTION.pressure' as VariablePath)).toThrow('LD-01 engine failed at t=0.600 s')
    expect(failures).toHaveLength(1)
    expect(engine.failure()?.atMs).toBeCloseTo(600, 9)
  })

  test('an ADVANCE the unit refuses fail-stops the engine with the cause', async () => {
    const engine = await connect({ refuseAdvanceAtS: 101 })
    await expect(engine.advance(1_000)).rejects.toThrow(/ld01-unit refused ADVANCE: ADVANCE from 100\.1\d* s to 101\.1\d* s: the test double refuses here/u)
    expect(engine.failure()?.reason).toContain('the test double refuses here')
  })

  test('an ADVANCE past the owner\'s limit fails the engine by name and stops the child; nothing behind it hangs and the last checkpoint restarts', async () => {
    expect(ld01UnitAdvanceLimitS).toBe(10)
    const load = await fixtureLoad({ hangAdvanceAtS: 101 })
    const failures: NativeEngineFailure[] = []
    const engine = await connect({}, { load, onFailure: failure => { failures.push(failure) } })
    await engine.advance(500)
    const lastGood = await engine.checkpoint()
    const saved = JSON.stringify(lastGood)
    const startedAt = performance.now()
    const [hung, behind] = await Promise.allSettled([engine.advance(1_000), engine.checkpoint()])
    const waitedS = (performance.now() - startedAt) / 1_000
    expect(waitedS).toBeGreaterThanOrEqual(ld01UnitAdvanceLimitS)
    expect(hung.status === 'rejected' && String(hung.reason)).toMatch(/LD-01 engine failed at t=0\.600 s: ld01-unit \(pid \d+\): ADVANCE \d+ to 101\.\d+ s went 10\.\d+ s without a reply, past the 10 s limit/u)
    expect(behind.status === 'rejected' && String(behind.reason)).toContain('past the 10 s limit')
    expect(failures).toHaveLength(1)
    await engine.close()
    const pid = Number(/pid (\d+)/u.exec(failures[0]!.reason)![1])
    expect(() => process.kill(pid, 0)).toThrow()
    expect(JSON.stringify(engine.persisted())).toBe(saved)
    const restarted = await connect({}, { load, restored: lastGood })
    expect(restarted.runtime.elapsedMs()).toBeCloseTo(600, 9)
    expect((await restarted.advance(200)).simulatedMs).toBeCloseTo(200, 6)
    expect(restarted.failure()).toBeNull()
  }, 30_000)
  test('a named domain end holds the last frame: nothing fails, nothing runs past it, commands refuse by name', async () => {
    const engine = await connect({ endAtS: 101.05 })
    const receipt = await engine.advance(2_000)
    expect(receipt.frame!.t).toBe(101.05)
    expect(engine.failure()).toBeNull()
    expect(engine.ended()).toEqual({ atMs: expect.closeTo(1_050, 6), label: 'solidPzr', reason: 'Simulation domain end: pressurizer solid at t=1.050 s' })
    expect(engine.runtime.domainEnd?.()).toBe('Simulation domain end: pressurizer solid at t=1.050 s')
    const held = engine.runtime.readVariable('PROTECTION.pressure' as VariablePath)
    expect(await engine.advance(1_000)).toEqual({ simulatedMs: 0, frame: null, cost: { wallS: 0, cpuS: 0 } })
    expect(engine.runtime.readVariable('PROTECTION.pressure' as VariablePath)).toBe(held)
    expect(() => engine.runtime.writeCommand({ type: 'setVariable', path: 'PROTECTION.manualReactorTrip' as VariablePath, value: true })).toThrow('takes no command: Simulation domain end')
    expect((await engine.checkpoint()).snapshot).not.toBeNull()
    expect(engine.failure()).toBeNull()
  })

  test('refuses at LOAD a tag map naming a channel the unit does not deliver', async () => {
    const load = await fixtureLoad({ channels: fixtureChannels.filter(channel => channel.id !== 'LD01.PROT.I1.TRIP') })
    await expect(connectNativeProcessPlantEngine({ plant, tagMap, load, artifactSha256, command: double }))
      .rejects.toThrow('PROTECTION.tripped reads channel LD01.PROT.I1.TRIP, which the unit does not deliver')
  })
})

describe('the LD-01 native artifact', () => {
  const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')
  const artifactAt = async (): Promise<{ readonly directory: string; readonly files: Record<string, string> }> => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-ld01-artifact-'))
    cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
    const files: Record<string, string> = {
      'lib/libtest.dylib': 'a library the binary would load\n',
      'bin/ld01-unit': '#!/bin/sh\nexit 2\n',
      'packets/joined.json': '{}', 'packets/ic.json': '{}', 'packets/pzr-control.json': '{}', 'packets/elec.json': '{}', 'packets/s3-state.json': '{}',
      'wiki/world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md': '# page\n',
      'ld01-graph.json': JSON.stringify({ format: 'ld01-plant-graph', sources: { packet: 'c'.repeat(64) }, scope: ['test graph'], graph: plant.sourceGraph, tagMap, automation: {} }),
      'artifact.json': JSON.stringify({
        format: 'ld01-unit-artifact', binary: 'bin/ld01-unit', libraries: ['lib/libtest.dylib'], graph: 'ld01-graph.json',
        load: {
          inputs: { packet: 'packets/joined.json', wiki_root: 'wiki', wiki_commit: null, wiki_repository: null, ic: 'packets/ic.json', pzr_control: 'packets/pzr-control.json', pzr_control_wiki: 'wiki', elec: 'packets/elec.json' },
          state: 'packets/s3-state.json', solver: { weights: 'declared', first_step: 'declared', stepping: 'free', water: 'if97', source_atol: 'derived' },
        },
      }),
    }
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(directory, path, '..'), { recursive: true })
      await writeFile(join(directory, path), text)
    }
    await chmod(join(directory, 'bin/ld01-unit'), 0o755)
    await writeFile(join(directory, 'MANIFEST.sha256'), Object.entries(files).map(([path, text]) => `${sha256(text)}  ${path}\n`).join(''))
    return { directory, files }
  }

  test('is refused with the reason when LD01_UNIT_ARTIFACT names none, as production does', () => {
    expect(resolveLd01UnitArtifact({})).toEqual({ ok: false, reason: 'the LD-01 native engine is not installed here: LD01_UNIT_ARTIFACT names no artifact directory' })
    const missing = resolveLd01UnitArtifact({ LD01_UNIT_ARTIFACT: join(tmpdir(), 'no-such-ld01-artifact') })
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.reason).toContain('is not usable')
  })

  test('loads a verified artifact as absolute LOAD inputs, its graph and its tag map', async () => {
    const { directory } = await artifactAt()
    const artifact = loadLd01UnitArtifact(directory)
    expect(artifact.binary).toBe(join(directory, 'bin/ld01-unit'))
    expect(artifact.load.inputs.packet).toBe(join(directory, 'packets/joined.json'))
    expect(artifact.load.inputs.wiki_root).toBe(join(directory, 'wiki'))
    expect(artifact.tagMap).toEqual(tagMap)
    expect(String(artifact.graph.id)).toBe('ld01.test')
  })

  test('is refused when a library it names is missing', async () => {
    const { directory } = await artifactAt()
    await rename(join(directory, 'lib/libtest.dylib'), join(directory, 'lib/moved.dylib'))
    const resolution = resolveLd01UnitArtifact({ LD01_UNIT_ARTIFACT: directory })
    expect(resolution.ok).toBe(false)
    expect(!resolution.ok && resolution.reason).toContain('lib/libtest.dylib')
  })

  test('is refused when a file differs from its manifest digest', async () => {
    const { directory } = await artifactAt()
    await writeFile(join(directory, 'packets/ic.json'), '{"changed":true}')
    const resolution = resolveLd01UnitArtifact({ LD01_UNIT_ARTIFACT: directory })
    expect(resolution.ok).toBe(false)
    expect(!resolution.ok && resolution.reason).toMatch(/packets\/ic\.json has SHA-256 [a-f0-9]{64}, the manifest says [a-f0-9]{64}/u)
  })
})
