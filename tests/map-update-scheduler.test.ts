import { describe, expect, test } from 'bun:test'
import { createMapUpdateScheduler } from '../src/ui/map-runtime/map-update-scheduler.ts'

const runFrame = (
  frame: FrameRequestCallback | null,
  time: number,
): void => {
  if (!frame) throw new Error('expected scheduled frame')
  frame(time)
}

describe('MapUpdateScheduler', () => {
  test('coalesces repeated updates for the same render family', () => {
    let frame: FrameRequestCallback | null = null
    const calls: string[] = []
    const scheduler = createMapUpdateScheduler({
      now: () => 100,
      requestFrame: callback => {
        frame = callback
        return 1
      },
      cancelFrame: () => undefined,
    })

    scheduler.schedule({
      family: 'operational-points',
      priority: 20,
      run: () => calls.push('old'),
    })
    scheduler.schedule({
      family: 'operational-points',
      priority: 40,
      run: () => calls.push('new'),
    })
    runFrame(frame, 100)

    expect(calls).toEqual(['new'])
  })

  test('runs higher-priority families first within a frame', () => {
    let frame: FrameRequestCallback | null = null
    const calls: string[] = []
    const scheduler = createMapUpdateScheduler({
      now: () => 100,
      requestFrame: callback => {
        frame = callback
        return 1
      },
      cancelFrame: () => undefined,
    })

    scheduler.schedule({
      family: 'operational-areas',
      priority: 10,
      run: () => calls.push('areas'),
    })
    scheduler.schedule({
      family: 'operational-points',
      priority: 90,
      run: () => calls.push('points'),
    })
    runFrame(frame, 100)

    expect(calls).toEqual(['points', 'areas'])
  })

  test('respects family throttles without dropping the pending update', () => {
    let nowMs = 1_000
    let frame: FrameRequestCallback | null = null
    let frameId = 0
    const calls: number[] = []
    const scheduler = createMapUpdateScheduler({
      now: () => nowMs,
      requestFrame: callback => {
        frame = callback
        frameId += 1
        return frameId
      },
      cancelFrame: () => undefined,
    })

    scheduler.schedule({
      family: 'operational-paths',
      priority: 10,
      minIntervalMs: 500,
      run: () => calls.push(nowMs),
    })
    runFrame(frame, nowMs)
    scheduler.schedule({
      family: 'operational-paths',
      priority: 10,
      minIntervalMs: 500,
      run: () => calls.push(nowMs),
    })
    runFrame(frame, nowMs)
    nowMs = 1_600
    runFrame(frame, nowMs)

    expect(calls).toEqual([1_000, 1_600])
  })
})
