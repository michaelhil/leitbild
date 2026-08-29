import {
  moduleBindingSchema,
  moduleDiscoverySchema,
  moduleIdSchema,
  newWorkspaceId,
  type ModuleBinding,
  type ModuleDiscovery,
  type ModuleId,
  type WorkspaceId,
} from '@samsinn-leitbild/platform-contracts'
import type { SuiteWorkspaceDirectory } from './directory.ts'
import {
  moduleTargetSchema,
  suiteWorkspaceSchema,
  type ModuleProvisioning,
  type ModuleTarget,
  type SuiteWorkspace,
} from './model.ts'

const normalizeBaseUrl = (raw: string): string => {
  const url = new URL(raw)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const discoveryUrlFor = (target: ModuleTarget): string =>
  `${normalizeBaseUrl(target.baseUrl)}/.well-known/${target.moduleId}`

const expandWorkspaceTemplate = (
  discovery: ModuleDiscovery,
  template: string | undefined,
  workspaceId: WorkspaceId,
  label: string,
): string => {
  if (!template) throw new Error(`Module ${discovery.module.id} does not advertise a ${label} link`)
  if (!template.includes('{workspaceId}')) {
    throw new Error(`Module ${discovery.module.id} ${label} link has no {workspaceId} placeholder`)
  }
  return template.replaceAll('{workspaceId}', workspaceId)
}

interface DiscoveredModule {
  readonly target: ModuleTarget
  readonly discovery: ModuleDiscovery
  readonly binding: ModuleBinding
  readonly workspaceApiUrl: string
  readonly workspaceUrl: string
}

export interface SuiteCoordinator {
  readonly list: () => Promise<ReadonlyArray<SuiteWorkspace>>
  readonly get: (id: WorkspaceId) => Promise<SuiteWorkspace | undefined>
  readonly create: (config: {
    readonly displayName: string
    readonly moduleIds?: ReadonlyArray<ModuleId>
  }) => Promise<SuiteWorkspace>
  readonly provision: (id: WorkspaceId) => Promise<SuiteWorkspace>
}

export const createSuiteCoordinator = (config: {
  readonly directory: SuiteWorkspaceDirectory
  readonly modules: ReadonlyArray<ModuleTarget>
  readonly fetch?: typeof fetch
}): SuiteCoordinator => {
  const fetchImpl = config.fetch ?? fetch
  const targets = config.modules.map(target => moduleTargetSchema.parse({
    ...target,
    baseUrl: normalizeBaseUrl(target.baseUrl),
  }))
  const targetById = new Map(targets.map(target => [target.moduleId, target]))
  if (targetById.size !== targets.length) throw new Error('Suite Module targets must have unique ids')

  const discover = async (target: ModuleTarget, workspaceId: WorkspaceId): Promise<DiscoveredModule> => {
    const discoveryUrl = discoveryUrlFor(target)
    const response = await fetchImpl(discoveryUrl, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`discovery returned HTTP ${response.status}`)
    const discovery = moduleDiscoverySchema.parse(await response.json())
    if (discovery.module.id !== target.moduleId) {
      throw new Error(`discovery identifies Module ${discovery.module.id}, expected ${target.moduleId}`)
    }
    const binding = moduleBindingSchema.parse({
      moduleId: target.moduleId,
      baseUrl: target.baseUrl,
      discoveryUrl,
    })
    return {
      target,
      discovery,
      binding,
      workspaceApiUrl: expandWorkspaceTemplate(discovery, discovery.workspaceScope.pathTemplate, workspaceId, 'Workspace API'),
      workspaceUrl: expandWorkspaceTemplate(discovery, discovery.links.workspaceUi, workspaceId, 'Workspace UI'),
    }
  }

  const provision = async (id: WorkspaceId): Promise<SuiteWorkspace> => {
    const workspace = await config.directory.get(id)
    if (!workspace) throw new Error(`Workspace not found: ${id}`)
    const selectedTargets = workspace.modules.map(module => {
      const target = targetById.get(module.moduleId)
      if (!target) throw new Error(`Suite has no configuration for Module ${module.moduleId}`)
      return target
    })

    const discoveryResults = await Promise.all(selectedTargets.map(async target => {
      try {
        return { ok: true as const, value: await discover(target, id) }
      } catch (error) {
        return { ok: false as const, target, error: error instanceof Error ? error.message : String(error) }
      }
    }))
    const discovered = discoveryResults.flatMap(result => result.ok ? [result.value] : [])
    const bindings = discovered.map(module => module.binding)
    const discoveredById = new Map(discovered.map(module => [module.target.moduleId, module]))
    const discoveryFailureById = new Map(
      discoveryResults.flatMap(result => result.ok ? [] : [[result.target.moduleId, result.error] as const]),
    )

    const timestamp = new Date().toISOString()
    const modules = await Promise.all(selectedTargets.map(async (target): Promise<ModuleProvisioning> => {
      const discoveryFailure = discoveryFailureById.get(target.moduleId)
      if (discoveryFailure) {
        return {
          moduleId: target.moduleId,
          baseUrl: target.baseUrl,
          status: 'failed',
          error: discoveryFailure,
          updatedAt: timestamp,
        }
      }
      const module = discoveredById.get(target.moduleId)!
      try {
        const response = await fetchImpl(module.workspaceApiUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ displayName: workspace.displayName, modules: bindings }),
        })
        if (!response.ok) throw new Error(`provisioning returned HTTP ${response.status}`)
        return {
          moduleId: target.moduleId,
          baseUrl: target.baseUrl,
          status: 'ready',
          binding: module.binding,
          workspaceUrl: module.workspaceUrl,
          updatedAt: timestamp,
        }
      } catch (error) {
        return {
          moduleId: target.moduleId,
          baseUrl: target.baseUrl,
          status: 'failed',
          binding: module.binding,
          workspaceUrl: module.workspaceUrl,
          error: error instanceof Error ? error.message : String(error),
          updatedAt: timestamp,
        }
      }
    }))

    return await config.directory.save(suiteWorkspaceSchema.parse({
      ...workspace,
      modules,
      updatedAt: timestamp,
    }))
  }

  return {
    list: config.directory.list,
    get: config.directory.get,
    create: async createConfig => {
      const displayName = createConfig.displayName.trim()
      if (displayName.length === 0) throw new Error('Workspace display name must be non-empty')
      const selectedIds = createConfig.moduleIds ?? targets.map(target => target.moduleId)
      if (new Set(selectedIds).size !== selectedIds.length) throw new Error('Module ids must be unique')
      const timestamp = new Date().toISOString()
      const workspace = await config.directory.save(suiteWorkspaceSchema.parse({
        id: newWorkspaceId(),
        displayName,
        modules: selectedIds.map(moduleId => {
          const target = targetById.get(moduleId)
          if (!target) throw new Error(`Unknown Module: ${moduleId}`)
          return {
            moduleId: target.moduleId,
            baseUrl: target.baseUrl,
            status: 'pending',
            updatedAt: timestamp,
          }
        }),
        createdAt: timestamp,
        updatedAt: timestamp,
      }))
      return await provision(workspace.id)
    },
    provision,
  }
}

export const parseModuleTargets = (values: ReadonlyArray<{ readonly moduleId: string; readonly baseUrl: string }>): ReadonlyArray<ModuleTarget> =>
  values.map(value => moduleTargetSchema.parse({
    moduleId: moduleIdSchema.parse(value.moduleId),
    baseUrl: value.baseUrl,
  }))
