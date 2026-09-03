import type { RoutingAdapter } from './protocol.ts'
import { createDirectRoutingAdapter } from './direct-adapter.ts'
import { createOsrmRoutingAdapter } from './osrm-adapter.ts'

export const createRoutingAdapterFromEnv = (env: NodeJS.ProcessEnv = process.env): RoutingAdapter => {
  const provider = env.LEITBILD_ROUTING_PROVIDER ?? 'direct'
  if (provider === 'direct') return createDirectRoutingAdapter()
  if (provider === 'osrm') {
    const baseUrl = env.LEITBILD_OSRM_URL
    if (!baseUrl) {
      throw new Error('LEITBILD_OSRM_URL is required when LEITBILD_ROUTING_PROVIDER=osrm')
    }
    const timeoutMs = env.LEITBILD_ROUTING_TIMEOUT_MS === undefined
      ? undefined
      : Number(env.LEITBILD_ROUTING_TIMEOUT_MS)
    return createOsrmRoutingAdapter({ baseUrl, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  }
  throw new Error(`unsupported routing provider: ${provider}`)
}
