import {
  createLd01UnitReplyReader,
  decodeLd01UnitText,
  encodeLd01UnitRequest,
  ld01UnitOpName,
  ld01UnitOps,
  type Ld01UnitOp,
  type Ld01UnitReply,
} from './protocol.ts'

// One `ld01-unit` child process over its stdin/stdout pipes (shell design §1, platform design §4 option i).
// One request is in flight at a time; nothing is retried. A child that exits other than by CLOSE, or
// writes a malformed reply, fails: every pending and every later request rejects with that cause, and
// nothing starts it again.

/** An explicit refusal by the child (reply status 1): its state is the child's to judge (it may fail-stop). */
export interface Ld01UnitRefusal extends Error {
  readonly kind: 'ld01-unit-refusal'
  readonly op: string
}

export const isLd01UnitRefusal = (error: unknown): error is Ld01UnitRefusal =>
  error instanceof Error && (error as Partial<Ld01UnitRefusal>).kind === 'ld01-unit-refusal'

const refusal = (op: Ld01UnitOp, cause: string): Ld01UnitRefusal =>
  Object.assign(new Error(`ld01-unit refused ${ld01UnitOpName(op)}: ${cause}`), { kind: 'ld01-unit-refusal' as const, op: ld01UnitOpName(op) })

export interface Ld01UnitChild {
  readonly pid: number
  /** Sends one request after the previous one is answered; resolves with an ok reply, rejects on a refusal or a failure. */
  readonly request: (op: Ld01UnitOp, payload: Uint8Array) => Promise<Ld01UnitReply>
  /** Why the child failed, or null while it serves. */
  readonly failure: () => string | null
  /** Sends CLOSE and awaits the exit; a child that already failed is only reaped. */
  readonly close: () => Promise<void>
}

const stderrTailLines = 20

export const spawnLd01UnitChild = (config: {
  /** argv of the child: the artifact's binary (tests: a protocol double). */
  readonly command: ReadonlyArray<string>
  /** Called once when the child fails, with the cause every request now rejects with. */
  readonly onFailure?: (cause: string) => void
}): Ld01UnitChild => {
  if (config.command.length === 0) throw new Error('ld01-unit command is empty')
  const proc = Bun.spawn([...config.command], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const reader = createLd01UnitReplyReader()
  const stderrTail: string[] = []
  let failure: string | null = null
  let closing = false
  let seq = 0
  let tail: Promise<unknown> = Promise.resolve()
  let pending: { readonly seq: number; readonly op: Ld01UnitOp; readonly resolve: (reply: Ld01UnitReply) => void; readonly reject: (error: Error) => void } | null = null

  const fail = (cause: string): void => {
    if (failure !== null) return
    failure = stderrTail.length === 0 ? cause : `${cause}; stderr: ${stderrTail.join(' | ')}`
    const waiting = pending
    pending = null
    waiting?.reject(new Error(failure))
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    config.onFailure?.(failure)
  }

  const readStdout = async (): Promise<void> => {
    try {
      for await (const chunk of proc.stdout) {
        for (const reply of reader.push(chunk)) {
          const waiting = pending
          if (waiting === null) throw new Error(`ld01-unit replied seq ${reply.seq} with no request in flight`)
          if (reply.seq !== waiting.seq) throw new Error(`ld01-unit replied seq ${reply.seq} to request seq ${waiting.seq}`)
          pending = null
          if (reply.status === 'ok') waiting.resolve(reply)
          else waiting.reject(refusal(waiting.op, decodeLd01UnitText(reply.payload)))
        }
      }
    } catch (error) {
      fail(`ld01-unit (pid ${proc.pid}) wrote a malformed reply: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const readStderr = async (): Promise<void> => {
    const decoder = new TextDecoder()
    let partial = ''
    for await (const chunk of proc.stderr) {
      const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        if (line.length === 0) continue
        console.error(`ld01-unit[${proc.pid}]: ${line}`)
        stderrTail.push(line)
        if (stderrTail.length > stderrTailLines) stderrTail.shift()
      }
    }
  }

  const watchExit = async (): Promise<void> => {
    const code = await proc.exited
    if (closing && code === 0) {
      // Closed as asked: a request still waiting (CLOSE itself, whose reply may not precede the exit) ends here.
      const waiting = pending
      pending = null
      waiting?.reject(new Error(`ld01-unit (pid ${proc.pid}) exited after CLOSE`))
      return
    }
    const signal = proc.signalCode
    fail(`ld01-unit (pid ${proc.pid}) ${signal === null ? `exited with code ${code}` : `was killed by ${signal}`}${closing ? ' while closing' : ''}`)
  }

  void readStdout()
  void readStderr()
  void watchExit()

  const send = async (op: Ld01UnitOp, payload: Uint8Array): Promise<Ld01UnitReply> => {
    if (failure !== null) throw new Error(failure)
    if (closing && op !== ld01UnitOps.close) throw new Error(`ld01-unit (pid ${proc.pid}) is closing: ${ld01UnitOpName(op)} refused`)
    seq += 1
    const requestSeq = seq
    const reply = new Promise<Ld01UnitReply>((resolve, reject) => { pending = { seq: requestSeq, op, resolve, reject } })
    try {
      proc.stdin.write(encodeLd01UnitRequest(op, requestSeq, payload))
      await proc.stdin.flush()
    } catch (error) {
      fail(`ld01-unit (pid ${proc.pid}) stdin: ${error instanceof Error ? error.message : String(error)}`)
    }
    return await reply
  }

  const request = (op: Ld01UnitOp, payload: Uint8Array): Promise<Ld01UnitReply> => {
    const queued = (async (): Promise<Ld01UnitReply> => {
      // The previous request's outcome is its own caller's; this one only waits for it to finish.
      await Promise.allSettled([tail])
      return await send(op, payload)
    })()
    tail = queued
    return queued
  }

  return {
    pid: proc.pid,
    request,
    failure: () => failure,
    close: async (): Promise<void> => {
      if (failure === null && !closing) {
        const closed = request(ld01UnitOps.close, new Uint8Array(0))
        closing = true
        // Its reply or its exit ends CLOSE; an exit other than 0 fails the child (watchExit).
        await Promise.allSettled([closed])
        proc.stdin.end()
      }
      await proc.exited
    },
  }
}
