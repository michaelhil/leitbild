// ============================================================================
// Provider stack construction. Extracted from bootstrap.ts so the dependency order
// (load store → providerKeys → providerSetup → DeploymentRuntime) lives in one
// place and the contract between steps is visible.
//
// Returns the DeploymentRuntime + the providerKeys reference (callers may need
// it for live key edits in the providers admin endpoint).
// ============================================================================

import { sharedPaths } from '../core/paths.ts'
import { createDeploymentRuntime, type DeploymentRuntime } from '../core/deployment-runtime.ts'
import { createLimitMetrics, type LimitMetrics } from '../core/limit-metrics.ts'
import { parseProviderConfig, summariseProviderConfig, type ProviderConfig } from '../llm/providers-config.ts'
import { buildProvidersFromConfig } from '../llm/providers-setup.ts'
import { createProviderPolicyStore, loadProviderStore, mergeWithEnv } from '../llm/providers-store.ts'
import { createProviderKeys, type ProviderKeys } from '../llm/provider-keys.ts'

export interface ProviderStack {
  readonly providerConfig: ProviderConfig
  readonly providerKeys: ProviderKeys
  readonly limitMetrics: LimitMetrics
  readonly deployment: DeploymentRuntime
}

export const buildProviderStack = async (): Promise<ProviderStack> => {
  // 1. Load store + merge env. Warnings logged but not fatal.
  const providersStorePath = sharedPaths.providers()
  const { data: storeData, warnings: storeWarnings } = await loadProviderStore(providersStorePath)
  for (const w of storeWarnings) console.warn(`[providers.json] ${w}`)
  const fileStore = mergeWithEnv(storeData)

  // 2. Parse config (env + file overlay).
  const providerConfig = parseProviderConfig({ fileStore })

  // 3. Construct limitMetrics first so the same object flows into the
  // cloud-provider adapters (SSE-overflow tracking) AND DeploymentRuntime.
  const limitMetrics = createLimitMetrics()

  // 4. Build providerKeys BEFORE providerSetup. The router's
  // isProviderEnabled filter is wired from providerKeys.isEnabled — without
  // it, the router walks every provider in the order, including keyless
  // ones (anthropic), and throws auth errors on every chat call.
  const providerKeys = createProviderKeys(fileStore)
  for (const [name, cc] of Object.entries(providerConfig.cloud)) {
    if (cc?.apiKey) providerKeys.set(name, cc.apiKey)
  }

  // 5. Build providerSetup (gateways + router) using the keys we just made.
  const providerSetup = buildProvidersFromConfig(providerConfig, { limitMetrics, providerKeys })

  // 6. Construct DeploymentRuntime — same providerKeys, same limitMetrics, same
  // setup. Single source for live key edits.
  const providerPolicy = createProviderPolicyStore(providersStorePath, storeData)
  const deployment = createDeploymentRuntime({ providerConfig, providerSetup, limitMetrics, providerKeys, providerPolicy })

  return { providerConfig, providerKeys, limitMetrics, deployment }
}

export const summariseProviders = (config: ProviderConfig): string =>
  summariseProviderConfig(config)
