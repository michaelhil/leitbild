import { describe, expect, test } from 'bun:test'
import type { MonitorState } from './provider-monitor.ts'
import { resolveProviderAvailability } from './provider-availability.ts'

const state = (sub: MonitorState['sub'], modelCount = 1): MonitorState => ({
  sub,
  reason: '',
  since: 1,
  retryAt: null,
  modelCount,
  lastError: null,
  lastErrorAt: null,
  consecutiveFailures: 0,
})

describe('resolveProviderAvailability', () => {
  test('preserves the canonical monitor state', () => {
    expect(resolveProviderAvailability(state('backoff'), { fallbackSub: 'ok' }).sub).toBe('backoff')
  })

  test('uses the declared static state when no monitor exists', () => {
    expect(resolveProviderAvailability(null, { fallbackSub: 'disabled' }).sub).toBe('disabled')
  })

  test('marks a model-serving provider down when it has no models', () => {
    const availability = resolveProviderAvailability(state('ok', 3), {
      fallbackSub: 'ok',
      modelCount: 0,
      requireModels: true,
    })
    expect(availability.sub).toBe('down')
    expect(availability.reason).toBe('no models available')
  })

  test('does not override an explicit unavailable state', () => {
    expect(resolveProviderAvailability(state('unhealthy', 0), {
      fallbackSub: 'ok',
      requireModels: true,
    }).sub).toBe('unhealthy')
  })
})
