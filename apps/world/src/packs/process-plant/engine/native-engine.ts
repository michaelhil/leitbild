import { z } from 'zod'
import { deriveProcessVariableCapabilities, type VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantCommand, ProcessPlantRuntime, ProcessPlantRuntimeSnapshot, ProcessPlantValue, ProcessPlantVariableSnapshot } from '../runtime/model.ts'
import type { ProcessPlantVariableHandle } from '../runtime/variable-table.ts'
import { toCanonicalProcessValue } from '../runtime/units.ts'
import type { Ld01UnitLoadRequest } from './artifact.ts'
import { spawnLd01UnitChild, type Ld01UnitChild } from './child.ts'
import {
  decodeLd01UnitAdvance,
  decodeLd01UnitJson,
  encodeLd01UnitAdvance,
  encodeLd01UnitJson,
  ld01UnitOps,
  type Ld01UnitAdvanceFrame,
} from './protocol.ts'
import { bindLd01TagMap, convertLd01Channel, ld01ChannelSchema, type Ld01Binding, type Ld01Command, type Ld01TagMap } from './tag-map.ts'

// The LD-01 Plant's engine: one `ld01-unit` child per Plant (shell design §2). It serves the Pack's
// synchronous runtime reads from the last observation frame, sends queued commands and one ADVANCE per
// exchange, and checkpoints by SNAPSHOT at an exchange boundary. A child that dies, or a unit that
// refuses an exchange, fails the engine "at t": every later read and advance throws with that cause, and
// nothing restarts it. Copy, checkpoint and close go through SNAPSHOT (platform design §6.1).

export const ld01EngineCheckpointFormat = 'ld01-unit' as const

/** f64 values as the child writes vectors: 16 hex digits of each value's IEEE bits, concatenated. */
const valuesToBits = (values: Float64Array): string => {
  const view = new DataView(new ArrayBuffer(8))
  let bits = ''
  for (const value of values) {
    view.setFloat64(0, value)
    bits += view.getBigUint64(0).toString(16).padStart(16, '0')
  }
  return bits
}

const valuesFromBits = (bits: string): Float64Array => {
  if (bits.length % 16 !== 0 || !/^[0-9a-f]*$/u.test(bits)) throw new Error('an LD-01 frame is not 16 hex digits per value')
  const values = new Float64Array(bits.length / 16)
  const view = new DataView(new ArrayBuffer(8))
  for (let index = 0; index < values.length; index += 1) {
    view.setBigUint64(0, BigInt(`0x${bits.slice(16 * index, 16 * index + 16)}`))
    values[index] = view.getFloat64(0)
  }
  return values
}

const timeBits = (t: number): string => valuesToBits(Float64Array.of(t))

/**
 * What the Run persists of an LD-01 Plant: the unit's start time (Plant time zero), its snapshot
 * (null: the unit as LOAD composes it, at its first frame) and the observation frame at that state.
 */
export const nativeProcessPlantCheckpointSchema = z.object({
  engine: z.literal(ld01EngineCheckpointFormat),
  /** The artifact the state belongs to (SHA-256 of its manifest); another artifact refuses it. */
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  originBits: z.string().regex(/^[0-9a-f]{16}$/u),
  snapshot: z.record(z.string(), z.unknown()).nullable(),
  frame: z.object({ tBits: z.string().regex(/^[0-9a-f]{16}$/u), valuesBits: z.string() }).strict(),
}).strict()
export type NativeProcessPlantCheckpoint = z.infer<typeof nativeProcessPlantCheckpointSchema>

export interface NativeEngineFailure {
  readonly atMs: number
  readonly reason: string
}

/** What the child reports a request cost it (its reply header): handler wall and thread CPU seconds. */
export interface NativeUnitCost {
  readonly wallS: number
  readonly cpuS: number
}

export interface NativeAdvanceReceipt {
  readonly simulatedMs: number
  readonly frame: Ld01UnitAdvanceFrame
  readonly cost: NativeUnitCost
}

export interface NativeProcessPlantEngine {
  readonly kind: 'native'
  /** The Pack's synchronous view: reads from the last frame, writes queue kernel commands for the next exchange. */
  readonly runtime: ProcessPlantRuntime
  /** Sends the queued commands at the unit's time, then ADVANCE by `elapsedMs`; resolves with the new frame. */
  readonly advance: (elapsedMs: number) => Promise<NativeAdvanceReceipt>
  /** SNAPSHOT at the next exchange boundary; the unit restarts in place there (copy rule), so source and copy share the future. */
  readonly checkpoint: () => Promise<NativeProcessPlantCheckpoint>
  /** The last checkpoint taken (or the unit's start), what a periodic flush persists without disturbing the unit. */
  readonly persisted: () => NativeProcessPlantCheckpoint
  readonly failure: () => NativeEngineFailure | null
  /** What LOAD (or RESTORE) and the first frame cost the child. */
  readonly connectCost: NativeUnitCost
  /** Snapshots a live unit (so a later connect resumes where it stood), then sends CLOSE. */
  readonly close: () => Promise<NativeProcessPlantCheckpoint>
}

const loadReplySchema = z.object({
  identity: z.record(z.string(), z.unknown()),
  t: z.number().finite(),
  t_bits: z.string().regex(/^[0-9a-f]{16}$/u),
  frame_s: z.number().finite().positive(),
  channels: z.array(ld01ChannelSchema),
}).passthrough()

export const connectNativeProcessPlantEngine = async (config: {
  readonly plant: CompiledProcessPlant
  readonly tagMap: Ld01TagMap
  readonly load: Ld01UnitLoadRequest
  readonly artifactSha256: string
  /** argv of the child: the artifact's binary (tests: a protocol double). */
  readonly command: ReadonlyArray<string>
  readonly restored?: NativeProcessPlantCheckpoint
  readonly onFailure?: (failure: NativeEngineFailure) => void
}): Promise<NativeProcessPlantEngine> => {
  const { plant } = config
  const restored = config.restored
  if (restored !== undefined && restored.artifactSha256 !== config.artifactSha256) {
    throw new Error(`LD-01 Plant ${plant.id} was saved on artifact ${restored.artifactSha256}, not this one (${config.artifactSha256}): no migration`)
  }
  let failure: NativeEngineFailure | null = null
  let state: { t: number; values: Float64Array } = { t: Number.NaN, values: new Float64Array(0) }
  let originS = Number.NaN
  const elapsedMs = (): number => (state.t - originS) * 1_000
  const fail = (reason: string): NativeEngineFailure => {
    if (failure !== null) return failure
    const at = Number.isFinite(state.t) ? elapsedMs() : 0
    failure = { atMs: at, reason: `LD-01 engine failed at t=${(at / 1_000).toFixed(3)} s: ${reason}` }
    config.onFailure?.(failure)
    return failure
  }
  const child: Ld01UnitChild = spawnLd01UnitChild({ command: config.command, onFailure: cause => { fail(cause) } })
  const json = async (op: typeof ld01UnitOps[keyof typeof ld01UnitOps], value: unknown, what: string): Promise<unknown> =>
    decodeLd01UnitJson((await child.request(op, encodeLd01UnitJson(value))).payload, what)

  let binding: Ld01Binding
  let persisted: NativeProcessPlantCheckpoint
  let connectCost: NativeUnitCost
  try {
    const composed = restored?.snapshot
      ? await child.request(ld01UnitOps.restore, encodeLd01UnitJson(restored.snapshot))
      : await child.request(ld01UnitOps.load, encodeLd01UnitJson(config.load))
    connectCost = { wallS: composed.wallS, cpuS: composed.cpuS }
    const reply = loadReplySchema.parse(decodeLd01UnitJson(composed.payload, restored?.snapshot ? 'RESTORE' : 'LOAD'))
    const channels = z.array(ld01ChannelSchema).parse(decodeLd01UnitJson((await child.request(ld01UnitOps.channels, new Uint8Array(0))).payload, 'CHANNELS'))
    if (JSON.stringify(channels) !== JSON.stringify(reply.channels)) throw new Error('CHANNELS differs from the channels LOAD replied')
    binding = bindLd01TagMap(plant.graph, config.tagMap, channels)
    originS = restored === undefined ? reply.t : valuesFromBits(restored.originBits)[0]!
    if (restored === undefined || restored.snapshot === null) {
      // The unit's first observation is its first I&C frame: the driver stops there anyway, so this exchange
      // adds no stop the trajectory would not make. A restored start state reproduces it bit for bit.
      const advanced = await child.request(ld01UnitOps.advance, encodeLd01UnitAdvance(reply.t + reply.frame_s))
      connectCost = { wallS: connectCost.wallS + advanced.wallS, cpuS: connectCost.cpuS + advanced.cpuS }
      const first = decodeLd01UnitAdvance(advanced.payload)
      if (first.values.length !== binding.channelCount) throw new Error(`the first frame carries ${first.values.length} values for ${binding.channelCount} channels`)
      if (restored !== undefined && (timeBits(first.t) !== restored.frame.tBits || valuesToBits(first.values) !== restored.frame.valuesBits)) {
        throw new Error('the restored start state does not reproduce its saved first frame bit for bit')
      }
      state = { t: first.t, values: first.values }
    } else {
      if (reply.t_bits !== restored.frame.tBits) throw new Error(`the snapshot stands at ${reply.t_bits}, its saved frame at ${restored.frame.tBits}`)
      const values = valuesFromBits(restored.frame.valuesBits)
      if (values.length !== binding.channelCount) throw new Error(`the saved frame carries ${values.length} values for ${binding.channelCount} channels`)
      state = { t: reply.t, values }
    }
    persisted = restored ?? {
      engine: ld01EngineCheckpointFormat,
      artifactSha256: config.artifactSha256,
      originBits: timeBits(originS),
      snapshot: null,
      frame: { tBits: timeBits(state.t), valuesBits: valuesToBits(state.values) },
    }
  } catch (error) {
    await child.close()
    throw new Error(`LD-01 Plant ${plant.id} could not connect its native engine: ${error instanceof Error ? error.message : String(error)}`)
  }

  const queued: Ld01Command[] = []
  let tail: Promise<unknown> = Promise.resolve()
  /** Advance, checkpoint and close each hold the unit alone, so a SNAPSHOT never lands between a COMMAND and its ADVANCE. */
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = (async (): Promise<T> => {
      await Promise.allSettled([tail])
      if (failure !== null) throw new Error(failure.reason)
      return await work()
    })()
    tail = run
    return run
  }
  const failed = (error: unknown): Error => new Error(fail(error instanceof Error ? error.message : String(error)).reason)

  const variables = plant.graph.variables
  const handles = new Map(variables.map((variable, slot) => [variable.path, { path: variable.path, variable, slot } satisfies ProcessPlantVariableHandle]))
  const resolve = (path: VariablePath): ProcessPlantVariableHandle => {
    const handle = handles.get(path)
    if (handle === undefined) throw new Error(`unknown process plant variable: ${path}`)
    return handle
  }
  const readHandle = (handle: ProcessPlantVariableHandle): ProcessPlantValue => {
    if (failure !== null) throw new Error(failure.reason)
    const bound = binding.byPath.get(handle.path)!
    if (bound.kind === 'command') return queued.includes(bound.command)
    return convertLd01Channel(bound, state.values[bound.channel]!)
  }
  const snapshotHandle = (handle: ProcessPlantVariableHandle): ProcessPlantVariableSnapshot => {
    const { variable } = handle
    const value = readHandle(handle)
    return {
      path: variable.path,
      label: variable.descriptor.label,
      value,
      canonicalValue: toCanonicalProcessValue(value, variable.descriptor.unit),
      quantity: variable.descriptor.quantity,
      unit: variable.descriptor.unit,
      discipline: variable.descriptor.discipline,
      kind: variable.descriptor.kind,
      writable: variable.descriptor.writable,
      published: variable.published,
      ...(variable.descriptor.tagId === undefined ? {} : { tagId: variable.descriptor.tagId }),
      ...(variable.descriptor.equipmentId === undefined ? {} : { equipmentId: variable.descriptor.equipmentId }),
      ...(variable.descriptor.description === undefined ? {} : { description: variable.descriptor.description }),
      ...(variable.descriptor.externalRefs === undefined ? {} : { externalRefs: variable.descriptor.externalRefs }),
      capabilities: deriveProcessVariableCapabilities({ descriptor: variable.descriptor, published: variable.published }),
      ...(variable.descriptor.limits === undefined ? {} : { limits: variable.descriptor.limits }),
    }
  }
  const queuedCommands = (): ReadonlyArray<ProcessPlantCommand> =>
    [...binding.byPath.values()].flatMap(bound => bound.kind === 'command' && queued.includes(bound.command) ? [{ type: 'setVariable' as const, path: bound.variable.path, value: true }] : [])

  const runtime: ProcessPlantRuntime = {
    tick: () => { throw new Error(`LD-01 Plant ${plant.id} advances through its native engine, not tick`) },
    elapsedMs,
    advancedMs: elapsedMs,
    resolveVariableHandle: resolve,
    readVariable: path => readHandle(resolve(path)),
    readVariableHandle: readHandle,
    readVariableSnapshot: path => snapshotHandle(resolve(path)),
    readVariableSnapshotHandle: snapshotHandle,
    writeCommand: (command: ProcessPlantCommand): void => {
      if (failure !== null) throw new Error(failure.reason)
      const bound = binding.byPath.get(command.path)
      if (bound?.kind !== 'command') throw new Error(`LD-01 Plant ${plant.id} takes no write to ${command.path}: only its kernel commands are writable`)
      if (command.value !== true) throw new Error(`${command.path} sends ${bound.command.kind} when written true; ${String(command.value)} sends nothing`)
      if (!queued.includes(bound.command)) queued.push(bound.command)
    },
    pwrTransientDiagnostics: () => { throw new Error(`transient diagnostics belong to the TS PWR runtime; LD-01 Plant ${plant.id} does not answer them`) },
    snapshot: (): ProcessPlantRuntimeSnapshot => ({
      graphSpecId: String(plant.graph.specId),
      variablePaths: variables.map(variable => variable.path),
      elapsedMs: elapsedMs(),
      remainderMs: 0,
      queuedCommands: queuedCommands(),
      variables: variables.map((_, slot) => snapshotHandle(resolve(variables[slot]!.path))),
    }),
    checkpoint: () => { throw new Error(`LD-01 Plant ${plant.id} checkpoints through SNAPSHOT (its native engine), not the TS runtime checkpoint`) },
  }

  const snapshot = async (): Promise<NativeProcessPlantCheckpoint> => {
    try {
      const reply = await child.request(ld01UnitOps.snapshot, new Uint8Array(0))
      const taken = z.record(z.string(), z.unknown()).parse(decodeLd01UnitJson(reply.payload, 'SNAPSHOT'))
      persisted = { ...persisted, snapshot: taken, frame: { tBits: timeBits(state.t), valuesBits: valuesToBits(state.values) } }
      return persisted
    } catch (error) {
      throw failed(error)
    }
  }

  return {
    kind: 'native',
    runtime,
    advance: (advanceMs: number) => exclusive(async (): Promise<NativeAdvanceReceipt> => {
      if (!Number.isFinite(advanceMs) || advanceMs <= 0) throw new Error(`LD-01 advance must be a positive number of ms, got ${advanceMs}`)
      try {
        const sending = queued.splice(0)
        for (const command of sending) await json(ld01UnitOps.command, { ...command, t_apply: state.t }, 'COMMAND')
        const advanced = await child.request(ld01UnitOps.advance, encodeLd01UnitAdvance(state.t + advanceMs / 1_000))
        const frame = decodeLd01UnitAdvance(advanced.payload)
        if (frame.values.length !== binding.channelCount) throw new Error(`a frame carries ${frame.values.length} values for ${binding.channelCount} channels`)
        const simulatedMs = (frame.t - state.t) * 1_000
        state = { t: frame.t, values: frame.values }
        return { simulatedMs, frame, cost: { wallS: advanced.wallS, cpuS: advanced.cpuS } }
      } catch (error) {
        throw failed(error)
      }
    }),
    checkpoint: () => exclusive(snapshot),
    persisted: () => persisted,
    failure: () => failure,
    connectCost,
    close: async (): Promise<NativeProcessPlantCheckpoint> => {
      // A failed unit keeps its last checkpoint; a live one is snapshotted first, and a refusal there fails it visibly.
      await Promise.allSettled([exclusive(snapshot)])
      await child.close()
      return persisted
    },
  }
}
