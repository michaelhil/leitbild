// Concurrency primitives for the LLM gateway: a fixed-capacity ring buffer
// for rolling metrics, and a bounded semaphore with queue timeout + shed.

import { createAbortError, createGatewayError } from './errors.ts'

// === Ring Buffer ===

export const createRingBuffer = <T>(capacity: number) => {
  const items: T[] = []
  let head = 0
  let count = 0

  const push = (item: T): void => {
    if (count < capacity) {
      items.push(item)
      count++
    } else {
      items[head] = item
      head = (head + 1) % capacity
    }
  }

  const toArray = (): T[] => {
    if (count < capacity) return items.slice()
    return [...items.slice(head), ...items.slice(0, head)]
  }

  const clear = (): void => {
    items.length = 0
    head = 0
    count = 0
  }

  return { push, toArray, clear, get count() { return count } }
}

// === Semaphore ===

interface QueuedRequest {
  readonly resolve: () => void
  readonly reject: (err: Error) => void
  readonly enqueuedAt: number
  readonly cleanup: () => void
}

export const createSemaphore = (max: number) => {
  let active = 0
  const queue: QueuedRequest[] = []

  const acquire = async (timeoutMs: number, maxQueueDepth: number, signal?: AbortSignal): Promise<number> => {
    if (signal?.aborted) throw createAbortError()
    const enqueuedAt = performance.now()
    if (active < max) {
      active++
      return 0 // no queue wait
    }
    if (queue.length >= maxQueueDepth) {
      throw createGatewayError('queue_full', 'LLM gateway queue full — request shed')
    }
    return new Promise<number>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        const idx = queue.indexOf(entry)
        if (idx !== -1) queue.splice(idx, 1)
        if (timer) clearTimeout(timer)
        reject(createAbortError())
      }
      const entry: QueuedRequest = {
        resolve: () => {
          entry.cleanup()
          resolve(Math.round(performance.now() - enqueuedAt))
        },
        reject,
        enqueuedAt,
        cleanup: () => {
          if (timer) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        },
      }
      queue.push(entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        const idx = queue.indexOf(entry)
        if (idx !== -1) {
          queue.splice(idx, 1)
          entry.cleanup()
          reject(createGatewayError('queue_timeout', `LLM gateway queue timeout after ${timeoutMs}ms`))
        }
      }, timeoutMs)
    })
  }

  const release = (): void => {
    const next = queue.shift()
    if (next) {
      next.resolve()
    } else {
      active--
    }
  }

  return {
    acquire,
    release,
    get active() { return active },
    get queueDepth() { return queue.length },
    updateMax: (newMax: number) => { max = newMax },
  }
}
