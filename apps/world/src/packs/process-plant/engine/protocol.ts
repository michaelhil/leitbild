// The `ld01-unit` child's framed protocol (water-ffi src/bin/ld01-unit.rs), pure encode and decode.
// Request: u32 len | u8 op | u32 seq | payload. Reply: u32 len | u8 status | u32 seq | f64 wall_s | f64 cpu_s |
// payload; little-endian, len counting the bytes after itself. Status 0 is ok, 1 an explicit refusal whose
// payload is the UTF-8 cause. Anything else is a malformed reply.

export const ld01UnitOps = {
  load: 1,
  channels: 2,
  advance: 3,
  command: 4,
  snapshot: 5,
  restore: 6,
  status: 7,
  close: 8,
} as const
export type Ld01UnitOp = typeof ld01UnitOps[keyof typeof ld01UnitOps]

const opNames: Readonly<Record<Ld01UnitOp, string>> = {
  1: 'LOAD', 2: 'CHANNELS', 3: 'ADVANCE', 4: 'COMMAND', 5: 'SNAPSHOT', 6: 'RESTORE', 7: 'STATUS', 8: 'CLOSE',
}
export const ld01UnitOpName = (op: Ld01UnitOp): string => opNames[op]

/** The names of an ADVANCE reply's counts, in the child's order (this exchange's own, not cumulative). */
export const ld01UnitAdvanceCounts = [
  'steps', 'residuals', 'jacobians', 'error_failures', 'convergence_failures', 'r_instants', 's_instants', 'frames',
] as const

export interface Ld01UnitReply {
  readonly status: 'ok' | 'refused'
  readonly seq: number
  readonly wallS: number
  readonly cpuS: number
  readonly payload: Uint8Array
}

export interface Ld01UnitAdvanceFrame {
  readonly t: number
  readonly solverT: number
  readonly counts: Readonly<Record<typeof ld01UnitAdvanceCounts[number], bigint>>
  readonly values: Float64Array
  /** The exchange's events (driver instants, protection, field and electrical logs); null when none occurred. */
  readonly events: unknown
}

const requestHeaderBytes = 4 + 1 + 4
const replyHeaderBytes = 1 + 4 + 8 + 8

export const encodeLd01UnitRequest = (op: Ld01UnitOp, seq: number, payload: Uint8Array): Uint8Array => {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffff_ffff) throw new Error(`ld01-unit request sequence ${seq} is not a u32`)
  const frame = new Uint8Array(requestHeaderBytes + payload.length)
  const view = new DataView(frame.buffer)
  view.setUint32(0, 1 + 4 + payload.length, true)
  view.setUint8(4, op)
  view.setUint32(5, seq, true)
  frame.set(payload, requestHeaderBytes)
  return frame
}

export const encodeLd01UnitJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

export const encodeLd01UnitAdvance = (t1: number): Uint8Array => {
  if (!Number.isFinite(t1)) throw new Error(`ADVANCE to ${t1} s is not a finite time`)
  const payload = new Uint8Array(8)
  new DataView(payload.buffer).setFloat64(0, t1, true)
  return payload
}

/**
 * Accumulates the child's stdout bytes and yields whole reply frames. A frame
 * shorter than its header is malformed: it throws, and the caller treats the
 * child as failed.
 */
export const createLd01UnitReplyReader = (): {
  readonly push: (chunk: Uint8Array) => ReadonlyArray<Ld01UnitReply>
  readonly pendingBytes: () => number
} => {
  let buffer = new Uint8Array(0)
  return {
    push: (chunk: Uint8Array): ReadonlyArray<Ld01UnitReply> => {
      const joined = new Uint8Array(buffer.length + chunk.length)
      joined.set(buffer)
      joined.set(chunk, buffer.length)
      buffer = joined
      const replies: Ld01UnitReply[] = []
      while (buffer.length >= 4) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        const length = view.getUint32(0, true)
        if (length < replyHeaderBytes) throw new Error(`ld01-unit reply frame of ${length} bytes holds no header`)
        if (buffer.length < 4 + length) break
        const status = view.getUint8(4)
        if (status !== 0 && status !== 1) throw new Error(`ld01-unit reply status ${status} is neither 0 (ok) nor 1 (refused)`)
        replies.push({
          status: status === 0 ? 'ok' : 'refused',
          seq: view.getUint32(5, true),
          wallS: view.getFloat64(9, true),
          cpuS: view.getFloat64(17, true),
          payload: buffer.slice(4 + replyHeaderBytes, 4 + length),
        })
        buffer = buffer.slice(4 + length)
      }
      return replies
    },
    pendingBytes: () => buffer.length,
  }
}

export const decodeLd01UnitText = (payload: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(payload)

export const decodeLd01UnitJson = (payload: Uint8Array, what: string): unknown => {
  try {
    return JSON.parse(decodeLd01UnitText(payload))
  } catch (error) {
    throw new Error(`ld01-unit ${what} reply is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** An ADVANCE reply: `f64 t, f64 solver_t, u32 c, c × u64 counts, u32 v, v × f64 values, u32 m, m bytes JSON events`. */
export const decodeLd01UnitAdvance = (payload: Uint8Array): Ld01UnitAdvanceFrame => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  let at = 0
  const need = (bytes: number, what: string): void => {
    if (at + bytes > payload.length) throw new Error(`ADVANCE reply ends inside its ${what} (${payload.length} bytes)`)
  }
  need(16, 'times')
  const t = view.getFloat64(0, true)
  const solverT = view.getFloat64(8, true)
  at = 16
  need(4, 'count length')
  const countLength = view.getUint32(at, true)
  at += 4
  if (countLength !== ld01UnitAdvanceCounts.length) throw new Error(`ADVANCE reply carries ${countLength} counts, not ${ld01UnitAdvanceCounts.length}`)
  need(8 * countLength, 'counts')
  const counts = Object.fromEntries(ld01UnitAdvanceCounts.map((name, index) => [name, view.getBigUint64(at + 8 * index, true)])) as Ld01UnitAdvanceFrame['counts']
  at += 8 * countLength
  need(4, 'value length')
  const valueLength = view.getUint32(at, true)
  at += 4
  need(8 * valueLength, 'values')
  const values = new Float64Array(valueLength)
  for (let index = 0; index < valueLength; index += 1) values[index] = view.getFloat64(at + 8 * index, true)
  at += 8 * valueLength
  need(4, 'event length')
  const eventLength = view.getUint32(at, true)
  at += 4
  need(eventLength, 'events')
  const events = eventLength === 0 ? null : decodeLd01UnitJson(payload.slice(at, at + eventLength), 'ADVANCE events')
  at += eventLength
  if (at !== payload.length) throw new Error(`ADVANCE reply has ${payload.length - at} bytes after its events`)
  return { t, solverT, counts, values, events }
}
