import {
  moduleFailureSchema,
  moduleIdSchema,
  moduleRegistrationSchema,
  workspaceModuleManifestSchema,
  type ModuleFailure,
  type ModuleId,
  type ModuleRegistration,
  type WorkspaceId,
  type WorkspaceModuleManifest,
} from '@samsinn-leitbild/platform-contracts'

export type ModuleOperationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: ModuleFailure }

export interface ModuleGateway {
  readonly list: () => ReadonlyArray<ModuleRegistration>
  readonly has: (moduleId: ModuleId) => boolean
  readonly join: (moduleId: ModuleId, workspaceId: WorkspaceId) => Promise<ModuleOperationResult>
  readonly leave: (moduleId: ModuleId, workspaceId: WorkspaceId) => Promise<ModuleOperationResult>
}

const normalizeBaseUrl = (value: string): string => {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const failure = (config: ModuleFailure): ModuleOperationResult => ({
  ok: false,
  failure: moduleFailureSchema.parse(config),
})

const expandWorkspacePath = (baseUrl: string, pathTemplate: string, workspaceId: WorkspaceId): string =>
  `${baseUrl}${pathTemplate.replaceAll('{workspaceId}', encodeURIComponent(workspaceId))}`

export const createModuleGateway = (config: {
  readonly registrations: ReadonlyArray<ModuleRegistration>
  readonly fetch?: typeof fetch
}): ModuleGateway => {
  const fetchImpl = config.fetch ?? fetch
  const registrations = config.registrations.map(registration => moduleRegistrationSchema.parse({
    ...registration,
    baseUrl: normalizeBaseUrl(registration.baseUrl),
  }))
  const byId = new Map(registrations.map(registration => [registration.moduleId, registration]))
  if (byId.size !== registrations.length) throw new Error('Module registrations must have unique ids')

  const discover = async (registration: ModuleRegistration): Promise<WorkspaceModuleManifest | ModuleFailure> => {
    let response: Response
    try {
      response = await fetchImpl(`${registration.baseUrl}${registration.manifestPath}`, {
        headers: { Accept: 'application/json' },
      })
    } catch (error) {
      return moduleFailureSchema.parse({
        code: 'module_unavailable',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      })
    }
    if (!response.ok) {
      return moduleFailureSchema.parse({
        code: 'module_discovery_failed',
        message: `Module discovery returned HTTP ${response.status}`,
        retryable: response.status >= 500,
      })
    }
    try {
      const manifest = workspaceModuleManifestSchema.parse(await response.json())
      if (manifest.module.id !== registration.moduleId) {
        return moduleFailureSchema.parse({
          code: 'module_identity_mismatch',
          message: `Module manifest identifies ${manifest.module.id}; expected ${registration.moduleId}`,
          retryable: false,
        })
      }
      return manifest
    } catch (error) {
      return moduleFailureSchema.parse({
        code: 'module_contract_invalid',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      })
    }
  }

  const operate = async (moduleId: ModuleId, workspaceId: WorkspaceId, method: 'PUT' | 'DELETE'): Promise<ModuleOperationResult> => {
    const registration = byId.get(moduleId)
    if (!registration) {
      return failure({ code: 'module_not_installed', message: `Module is not installed: ${moduleId}`, retryable: false })
    }
    const manifest = await discover(registration)
    if ('code' in manifest) return { ok: false, failure: manifest }
    const url = expandWorkspacePath(registration.baseUrl, manifest.endpoints.workspace, workspaceId)
    let response: Response
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Accept: 'application/json', ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'PUT' ? { body: JSON.stringify({ workspaceId }) } : {}),
      })
    } catch (error) {
      return failure({
        code: 'module_unavailable',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      })
    }
    if (!response.ok) {
      return failure({
        code: method === 'PUT' ? 'module_join_failed' : 'module_leave_failed',
        message: `Module lifecycle returned HTTP ${response.status}`,
        retryable: response.status >= 500,
      })
    }
    return { ok: true }
  }

  return {
    list: () => registrations,
    has: moduleId => byId.has(moduleIdSchema.parse(moduleId)),
    join: (moduleId, workspaceId) => operate(moduleId, workspaceId, 'PUT'),
    leave: (moduleId, workspaceId) => operate(moduleId, workspaceId, 'DELETE'),
  }
}
