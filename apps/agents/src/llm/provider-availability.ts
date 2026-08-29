import type { MonitorState, MonitorSubState } from './provider-monitor.ts'

export interface ResolveProviderAvailabilityOptions {
  readonly fallbackSub: MonitorSubState
  readonly modelCount?: number
  readonly requireModels?: boolean
}

export const resolveProviderAvailability = (
  monitor: MonitorState | null | undefined,
  options: ResolveProviderAvailabilityOptions,
): MonitorState => {
  const modelCount = options.modelCount ?? monitor?.modelCount ?? 0
  const current: MonitorState = monitor
    ? { ...monitor, modelCount }
    : {
        sub: options.fallbackSub,
        reason: '',
        since: 0,
        retryAt: null,
        modelCount,
        lastError: null,
        lastErrorAt: null,
        consecutiveFailures: 0,
      }

  if (options.requireModels && current.sub === 'ok' && modelCount === 0) {
    return { ...current, sub: 'down', reason: 'no models available' }
  }
  return current
}
