import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  moduleDiscoverySchema,
  type ModuleDiscovery,
} from '@samsinn-leitbild/platform-contracts'

const packageJsonPath = resolve(import.meta.dir, '../../../package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { readonly version?: unknown }
const implementationVersion = typeof packageJson.version === 'string' ? packageJson.version : 'unknown'

export const discoveryManifestSchema = moduleDiscoverySchema
export type DiscoveryManifest = ModuleDiscovery

const normalizeBaseUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const joinUrl = (baseUrl: string, path: string): string =>
  `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`

const websocketBaseUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString().replace(/\/$/, '')
}

export const buildManifest = (baseUrl: string): DiscoveryManifest => {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const wsBaseUrl = websocketBaseUrl(normalizedBaseUrl)
  const workspaceBase = joinUrl(normalizedBaseUrl, '/api/workspaces/{workspaceId}')
  const simulationRunBase = `${workspaceBase}/simulation-runs/{simulationRunId}`

  return moduleDiscoverySchema.parse({
    generatedAt: new Date().toISOString(),
    module: {
      id: 'leitbild',
      title: 'Leitbild',
      implementationVersion,
    },
    workspaceScope: {
      mode: 'path',
      pathTemplate: workspaceBase,
    },
    access: {
      posture: 'open',
      modes: ['open'],
    },
    links: {
      self: joinUrl(normalizedBaseUrl, '/.well-known/leitbild'),
      workspaces: joinUrl(normalizedBaseUrl, '/api/workspaces'),
      workspace: workspaceBase,
      workspaceUi: joinUrl(normalizedBaseUrl, '/workspaces/{workspaceId}'),
      capabilities: `${workspaceBase}/capabilities`,
      scenarios: `${workspaceBase}/scenarios`,
      scenario: `${workspaceBase}/scenarios/{scenarioId}`,
      simulationRuns: `${workspaceBase}/simulation-runs`,
      simulationRun: simulationRunBase,
      simulationRunSnapshot: `${simulationRunBase}/snapshot`,
      simulationRunEvents: `${simulationRunBase}/events{?afterSeq}`,
      simulationRunPackQueries: `${simulationRunBase}/queries`,
      simulationRunCapabilities: `${simulationRunBase}/capabilities`,
      simulationRunCommands: `${simulationRunBase}/commands`,
      simulationRunSignals: `${simulationRunBase}/signals`,
      simulationRunReset: `${simulationRunBase}/reset`,
      simulationRunClock: `${simulationRunBase}/clock`,
      realtime: `${joinUrl(wsBaseUrl, '/api/workspaces/{workspaceId}/ws')}?simulationRun={simulationRunId}`,
      mapCapabilities: joinUrl(normalizedBaseUrl, '/map/capabilities.json'),
      mapStyle: joinUrl(normalizedBaseUrl, '/map/style.json'),
      docs: 'https://github.com/michaelhil/leitbild/blob/main/docs/discovery.md',
    },
  })
}
