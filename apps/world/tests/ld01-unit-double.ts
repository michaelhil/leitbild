// A test double of the `ld01-unit` child (water-ffi src/bin/ld01-unit.rs): the same framed protocol on
// stdin/stdout, a toy unit behind it. Test-only: the native engine's tests spawn it with `bun` in place of the
// artifact's binary. LOAD's `inputs.packet` names its fixture: the channels with a value and a rate each
// (value + rate·(t − t0)), the channel a command sets to 1 from its time on, the times at which it kills
// itself, refuses an ADVANCE or stops answering (only the child that claims `hangClaimPath`, if named), the time of
// a named domain end, and a wall delay before each ADVANCE reply (a slow exchange).
import { openSync, readFileSync } from 'node:fs'

interface Fixture {
  readonly t0: number
  readonly frame_s: number
  readonly channels: ReadonlyArray<{ readonly id: string; readonly unit: string; readonly value: number; readonly rate: number; readonly setBy?: string }>
  readonly dieAtS?: number
  readonly refuseAdvanceAtS?: number
  readonly endAtS?: number
  readonly advanceDelayMs?: number
  readonly hangAdvanceAtS?: number
  readonly hangClaimPath?: string
}

/** Whether this child is the one to stop answering: the first to claim the path, or any without one. */
const claimsHang = (path: string | undefined): boolean => {
  if (path === undefined) return true
  try {
    openSync(path, 'wx')
    return true
  } catch {
    return false
  }
}

const bits = (x: number): string => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}
const fromBits = (hex: string): number => {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(`0x${hex}`))
  return view.getFloat64(0)
}

let unit: { fixture: Fixture; load: Record<string, unknown>; t: number; commands: Array<{ kind: string; t: number }>; failed: string | null } | null = null

// R4-ENDED: the named end this unit stands at; ADVANCE and COMMAND then refuse by name.
let ended: number | null = null

const channels = (fixture: Fixture) => fixture.channels.map(channel => ({ id: channel.id, unit: channel.unit, quantity: 'test quantity', source: 'test double' }))
const reply = () => ({ identity: { fixture: unit!.load }, t: unit!.t, t_bits: bits(unit!.t), dimension: 1, frame_s: unit!.fixture.frame_s, composition: {}, channels: channels(unit!.fixture), pid: process.pid })
const compose = (load: Record<string, unknown>) => {
  const inputs = load.inputs as { packet: string }
  const fixture = JSON.parse(readFileSync(inputs.packet, 'utf8')) as Fixture
  return { fixture, load, t: fixture.t0, commands: [] as Array<{ kind: string; t: number }>, failed: null as string | null }
}
const json = (payload: Uint8Array): Record<string, unknown> => JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>

const handle = (op: number, payload: Uint8Array): Uint8Array | 'close' => {
  const text = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
  if (op === 1 || op === 6) {
    if (unit !== null) throw new Error('a unit is loaded: one unit per process (LOAD or RESTORE once)')
    if (op === 1) {
      unit = compose(json(payload))
    } else {
      const snapshot = json(payload)
      if (snapshot.format !== 'ld01-unit-snapshot') throw new Error('not an ld01-unit-snapshot')
      unit = { ...compose(snapshot.load as Record<string, unknown>), t: fromBits(snapshot.t as string), commands: snapshot.commands as Array<{ kind: string; t: number }> }
    }
    return text(reply())
  }
  if (unit === null) throw new Error('no unit is loaded')
  if (op === 2) return text(channels(unit.fixture))
  if (op === 7) return text({ t: unit.t, failed: unit.failed })
  if (op === 8) return 'close'
  if (unit.failed !== null) throw new Error(`the unit fail-stopped: ${unit.failed}`)
  if (ended !== null && (op === 3 || op === 4)) throw new Error(`the unit ended at ${ended} s: solidPzr, the test double's cause`)
  if (op === 3) {
    const asked = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat64(0, true)
    if (!(asked > unit.t)) throw new Error(`ADVANCE to ${asked} s is not after the unit's ${unit.t} s`)
    const ending = unit.fixture.endAtS !== undefined && asked >= unit.fixture.endAtS
    const t1 = ending ? unit.fixture.endAtS! : asked
    if (ending) ended = t1
    if (unit.fixture.dieAtS !== undefined && t1 >= unit.fixture.dieAtS) process.kill(process.pid, 'SIGKILL')
    if (unit.fixture.refuseAdvanceAtS !== undefined && t1 >= unit.fixture.refuseAdvanceAtS) {
      unit.failed = `ADVANCE from ${unit.t} s to ${t1} s: the test double refuses here`
      throw new Error(unit.failed)
    }
    unit.t = t1
    const values = unit.fixture.channels.map(channel => channel.setBy !== undefined
      ? (unit!.commands.some(command => command.kind === channel.setBy && command.t <= t1) ? 1 : 0)
      : channel.value + channel.rate * (t1 - unit!.fixture.t0))
    const applied = unit.commands.filter(command => command.t <= t1).map(command => command.kind)
    const named = ending ? { ended: { label: 'solidPzr', plain: 'pressurizer solid', t: t1, cause: "the test double's cause" } } : {}
    const events = applied.length === 0 && !ending ? new Uint8Array(0) : text({ ...(applied.length === 0 ? {} : { applied }), ...named })
    const out = new Uint8Array(16 + 4 + 8 * 8 + 4 + 8 * values.length + 4 + events.length)
    const view = new DataView(out.buffer)
    let at = 0
    view.setFloat64(at, t1, true); at += 8
    view.setFloat64(at, t1, true); at += 8
    view.setUint32(at, 8, true); at += 4
    for (let index = 0; index < 8; index += 1) { view.setBigUint64(at, BigInt(index), true); at += 8 }
    view.setUint32(at, values.length, true); at += 4
    for (const value of values) { view.setFloat64(at, value, true); at += 8 }
    view.setUint32(at, events.length, true); at += 4
    out.set(events, at)
    return out
  }
  if (op === 4) {
    const command = json(payload)
    if (command.kind === 'StuckCluster') throw new Error('StuckCluster: the unit composes no cluster singly')
    if (typeof command.t_apply !== 'number' || command.t_apply < unit.t) throw new Error(`${String(command.kind)} at ${String(command.t_apply)} s is not prospective`)
    unit.commands.push({ kind: String(command.kind), t: command.t_apply })
    return text({ kind: command.kind, t_apply: command.t_apply, t_apply_bits: bits(command.t_apply) })
  }
  if (op === 5) {
    if (payload.length !== 0) throw new Error('SNAPSHOT takes no payload')
    return text({ format: 'ld01-unit-snapshot', identity: { fixture: unit.load }, load: unit.load, t: bits(unit.t), commands: unit.commands })
  }
  throw new Error(`unknown op ${op}`)
}

const frame = (status: number, seq: number, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + 21 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 21 + payload.length, true)
  view.setUint8(4, status)
  view.setUint32(5, seq, true)
  view.setFloat64(9, 0, true)
  view.setFloat64(17, 0, true)
  out.set(payload, 25)
  return out
}

let buffer = new Uint8Array(0)
let closed = false
serve: for await (const chunk of Bun.stdin.stream()) {
  const joined = new Uint8Array(buffer.length + chunk.length)
  joined.set(buffer)
  joined.set(chunk, buffer.length)
  buffer = joined
  while (buffer.length >= 4) {
    const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, true)
    if (buffer.length < 4 + length) break
    const body = buffer.slice(4, 4 + length)
    buffer = buffer.slice(4 + length)
    const op = body[0]!
    const seq = new DataView(body.buffer).getUint32(1, true)
    let outcome: Uint8Array | 'close'
    try {
      outcome = handle(op, body.slice(5))
    } catch (error) {
      process.stdout.write(frame(1, seq, new TextEncoder().encode(error instanceof Error ? error.message : String(error))))
      continue
    }
    if (outcome === 'close') {
      process.stdout.write(frame(0, seq, new Uint8Array(0)))
      closed = true
      break serve
    }
    const delayMs = op === 3 ? (unit as { fixture: Fixture } | null)?.fixture.advanceDelayMs : undefined
    if (delayMs !== undefined) await Bun.sleep(delayMs)
    const stalled = op === 3 ? (unit as { fixture: Fixture; t: number } | null) : null
    if (stalled?.fixture.hangAdvanceAtS !== undefined && stalled.t >= stalled.fixture.hangAdvanceAtS && claimsHang(stalled.fixture.hangClaimPath)) await Bun.sleep(3_600_000)
    process.stdout.write(frame(0, seq, outcome))
  }
}
if (!closed) {
  console.error('ld01-unit double: stdin closed without CLOSE')
  process.exit(2)
}
