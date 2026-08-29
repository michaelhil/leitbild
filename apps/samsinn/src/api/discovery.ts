import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { moduleDiscoverySchema, type ModuleDiscovery } from '@samsinn-leitbild/platform-contracts'
import { authEnabled } from './auth.ts'

const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8'),
) as { readonly version?: unknown }
const implementationVersion = typeof packageJson.version === 'string' ? packageJson.version : 'unknown'

const normalizedBaseUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const websocketBaseUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString().replace(/\/$/, '')
}

export const buildSamsinnDiscovery = (baseUrl: string): ModuleDiscovery => {
  const base = normalizedBaseUrl(baseUrl)
  const workspace = `${base}/api/workspaces/{workspaceId}`
  return moduleDiscoverySchema.parse({
    generatedAt: new Date().toISOString(),
    module: {
      id: 'samsinn',
      title: 'Samsinn',
      implementationVersion,
    },
    workspaceScope: {
      mode: 'path',
      pathTemplate: workspace,
    },
    access: authEnabled()
      ? { posture: 'restricted', modes: ['shared-token'] }
      : { posture: 'open', modes: ['open'] },
    links: {
      self: `${base}/.well-known/samsinn`,
      workspaces: `${base}/api/workspaces`,
      workspace,
      workspaceUi: `${base}/workspaces/{workspaceId}`,
      workspaceSettings: `${workspace}/settings`,
      rooms: `${workspace}/rooms`,
      agents: `${workspace}/agents`,
      scripts: `${workspace}/scripts`,
      documents: `${workspace}/documents`,
      workspacePacks: `${workspace}/packs`,
      packs: `${base}/api/packs`,
      capabilities: `${workspace}/capabilities`,
      realtime: `${websocketBaseUrl(base)}/api/workspaces/{workspaceId}/ws`,
    },
  })
}
