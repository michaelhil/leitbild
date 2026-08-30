import {
  capabilityIdSchema,
  coreModuleIds,
  createWorkspaceInputSchema,
  moduleIdSchema,
  moduleMembershipSchema,
  renameWorkspaceInputSchema,
  workspaceCapabilityCatalogSchema,
  workspaceIdSchema,
  workspaceResourceCatalogSchema,
  workspaceResourceReferenceSchema,
  type AccessContext,
  type CapabilityId,
  type CreateWorkspaceInput,
  type InvokeCapabilityInput,
  type ModuleId,
  type ModuleMembership,
  type RenameWorkspaceInput,
  type Workspace,
  type WorkspaceCapabilityCatalog,
  type WorkspaceId,
  type WorkspaceResourceCatalog,
} from '@leitbild/contracts'
import { hostError } from './errors.ts'
import type { ModuleGateway, ModuleOperationResult } from './module-gateway.ts'
import type { WorkspaceStore } from './store.ts'
import { getPreset, PRESET_CATALOG, type PresetDefinition } from './presets.ts'

export interface PresetActionOutcome {
  readonly capabilityId: CapabilityId
  readonly status: 'applied' | 'failed'
  readonly result?: unknown
  readonly error?: string
}

export interface PresetApplication {
  readonly presetId: string
  readonly status: 'applied' | 'partial' | 'failed'
  readonly outcomes: ReadonlyArray<PresetActionOutcome>
}

export interface WorkspaceHost {
  readonly list: () => ReadonlyArray<Workspace>
  readonly get: (id: WorkspaceId) => Workspace | undefined
  readonly create: (input: CreateWorkspaceInput) => Promise<Workspace>
  readonly rename: (id: WorkspaceId, input: RenameWorkspaceInput) => Workspace
  readonly delete: (id: WorkspaceId) => Promise<void>
  readonly retryModule: (id: WorkspaceId, moduleId: ModuleId) => Promise<Workspace>
  readonly resources: (id: WorkspaceId) => Promise<WorkspaceResourceCatalog>
  readonly capabilities: (id: WorkspaceId) => Promise<WorkspaceCapabilityCatalog>
  readonly invoke: (id: WorkspaceId, capabilityId: CapabilityId, input: InvokeCapabilityInput, access: AccessContext) => Promise<unknown>
  readonly presets: () => ReadonlyArray<PresetDefinition>
  readonly applyPreset: (id: WorkspaceId, presetId: string, access: AccessContext) => Promise<PresetApplication>
  readonly installedModuleIds: () => ReadonlyArray<ModuleId>
}

const membership = (
  moduleId: ModuleId,
  status: ModuleMembership['status'],
  result?: ModuleOperationResult,
): ModuleMembership => moduleMembershipSchema.parse({
  moduleId,
  status,
  ...(result?.ok === false ? { failure: result.failure } : {}),
  updatedAt: new Date().toISOString(),
})

export const createWorkspaceHost = (config: {
  readonly store: WorkspaceStore
  readonly modules: ModuleGateway
}): WorkspaceHost => {
  const installedModuleIds = config.modules.list().map(registration => registration.moduleId)
  for (const moduleId of coreModuleIds) {
    if (!config.modules.has(moduleId)) throw new Error(`Core Module is not installed: ${moduleId}`)
  }

  const requireWorkspace = (id: WorkspaceId): Workspace => {
    const workspace = config.store.get(id)
    if (!workspace) throw hostError({ status: 404, code: 'workspace_not_found', message: 'Workspace not found' })
    return workspace
  }

  const requireInstalledModule = (moduleId: ModuleId): void => {
    if (!config.modules.has(moduleId)) {
      throw hostError({ status: 404, code: 'module_not_installed', message: `Module is not installed: ${moduleId}` })
    }
  }

  const join = async (workspaceId: WorkspaceId, moduleId: ModuleId): Promise<Workspace> => {
    const result = await config.modules.join(moduleId, workspaceId)
    return config.store.setMembership(
      workspaceId,
      membership(moduleId, result.ok ? 'ready' : 'join_failed', result),
    )!
  }

  const unavailableMembershipFailure = (item: ModuleMembership) => item.failure ?? {
    code: 'module_not_ready',
    message: `Module lifecycle is ${item.status}`,
    retryable: item.status === 'joining' || item.status === 'leaving',
  }

  const invokeCapability = async (
    rawId: WorkspaceId,
    rawCapabilityId: CapabilityId,
    rawInput: InvokeCapabilityInput,
    access: AccessContext,
  ): Promise<unknown> => {
    const id = workspaceIdSchema.parse(rawId)
    const capabilityId = capabilityIdSchema.parse(rawCapabilityId)
    const workspace = requireWorkspace(id)
    const separator = capabilityId.indexOf('.')
    const moduleId = moduleIdSchema.parse(capabilityId.slice(0, separator))
    const active = workspace.modules.find(item => item.moduleId === moduleId)
    if (!active || active.status !== 'ready') {
      throw hostError({ status: 409, code: 'module_not_ready', message: `Capability Module is not ready in this Workspace: ${moduleId}` })
    }
    const resource = rawInput.resource === undefined ? undefined : workspaceResourceReferenceSchema.parse(rawInput.resource)
    if (resource !== undefined && (resource.workspaceId !== id || resource.moduleId !== moduleId)) {
      throw hostError({ status: 400, code: 'resource_scope_mismatch', message: 'Selected Resource does not belong to the Capability Module and Workspace' })
    }
    const result = await config.modules.invoke(moduleId, {
      workspaceId: id,
      capabilityId,
      ...(resource === undefined ? {} : { resource }),
      input: rawInput.input,
      access,
    })
    if (!result.ok) {
      throw hostError({
        status: 502,
        code: result.failure.code,
        message: result.failure.message,
        retryable: result.failure.retryable,
        details: { moduleId, capabilityId },
      })
    }
    return result.value.result
  }

  return {
    list: config.store.list,
    get: config.store.get,
    create: async rawInput => {
      const input = createWorkspaceInputSchema.parse(rawInput)
      const workspace = config.store.create({ name: input.name ?? null, moduleIds: installedModuleIds })
      await Promise.all(installedModuleIds.map(moduleId => join(workspace.id, moduleId)))
      return requireWorkspace(workspace.id)
    },
    rename: (rawId, rawInput) => {
      const id = workspaceIdSchema.parse(rawId)
      requireWorkspace(id)
      const input = renameWorkspaceInputSchema.parse(rawInput)
      return config.store.rename(id, input.name)!
    },
    delete: async rawId => {
      const id = workspaceIdSchema.parse(rawId)
      const workspace = requireWorkspace(id)
      for (const item of workspace.modules) {
        config.store.setMembership(id, membership(item.moduleId, 'leaving'))
      }
      const results = await Promise.all(workspace.modules.map(async item => ({
        moduleId: item.moduleId,
        result: await config.modules.leave(item.moduleId, id),
      })))
      const failures = results.filter(item => !item.result.ok)
      if (failures.length > 0) {
        for (const item of failures) {
          if (!item.result.ok) config.store.setMembership(id, membership(item.moduleId, 'leave_failed', item.result))
        }
        throw hostError({
          status: 502,
          code: 'workspace_delete_incomplete',
          message: 'One or more Modules could not remove their Workspace state',
          retryable: failures.some(item => !item.result.ok && item.result.failure.retryable),
          details: { moduleIds: failures.map(item => item.moduleId) },
        })
      }
      config.store.delete(id)
    },
    retryModule: async (rawId, rawModuleId) => {
      const id = workspaceIdSchema.parse(rawId)
      const moduleId = moduleIdSchema.parse(rawModuleId)
      const workspace = requireWorkspace(id)
      const existing = workspace.modules.find(item => item.moduleId === moduleId)
      if (!existing) {
        throw hostError({ status: 404, code: 'module_membership_not_found', message: `Module does not belong to Workspace: ${moduleId}` })
      }
      if (existing.status === 'join_failed') {
        config.store.setMembership(id, membership(moduleId, 'joining'))
        return await join(id, moduleId)
      }
      throw hostError({ status: 409, code: 'module_not_retryable', message: `Module lifecycle is not failed: ${moduleId}` })
    },
    resources: async rawId => {
      const id = workspaceIdSchema.parse(rawId)
      const workspace = requireWorkspace(id)
      const results = await Promise.all(workspace.modules.map(async item => {
        if (item.status !== 'ready') {
          return { moduleId: item.moduleId, result: { ok: false as const, failure: unavailableMembershipFailure(item) } }
        }
        return { moduleId: item.moduleId, result: await config.modules.resources(item.moduleId, id) }
      }))
      const outcomes = results.map(item => item.result.ok
        ? { moduleId: item.moduleId, status: 'ready' as const }
        : { moduleId: item.moduleId, status: 'failed' as const, failure: item.result.failure })
      const resources = results.flatMap(item => {
        if (!item.result.ok) return []
        const invalid = item.result.value.resources.find(resource =>
          resource.ref.workspaceId !== id || resource.ref.moduleId !== item.moduleId)
        if (invalid) {
          throw hostError({
            status: 502,
            code: 'module_contract_invalid',
            message: `Module ${item.moduleId} returned a Resource outside its ownership`,
          })
        }
        return item.result.value.resources
      })
      return workspaceResourceCatalogSchema.parse({ workspaceId: id, modules: outcomes, resources })
    },
    capabilities: async rawId => {
      const id = workspaceIdSchema.parse(rawId)
      const workspace = requireWorkspace(id)
      const results = await Promise.all(workspace.modules.map(async item => {
        if (item.status !== 'ready') {
          return { moduleId: item.moduleId, result: { ok: false as const, failure: unavailableMembershipFailure(item) } }
        }
        return { moduleId: item.moduleId, result: await config.modules.capabilities(item.moduleId, id) }
      }))
      const outcomes = results.map(item => item.result.ok
        ? { moduleId: item.moduleId, status: 'ready' as const }
        : { moduleId: item.moduleId, status: 'failed' as const, failure: item.result.failure })
      const capabilities = results.flatMap(item => {
        if (!item.result.ok) return []
        const invalid = item.result.value.capabilities.find(capability => capability.moduleId !== item.moduleId)
        if (invalid) {
          throw hostError({
            status: 502,
            code: 'module_contract_invalid',
            message: `Module ${item.moduleId} returned a Capability outside its ownership`,
          })
        }
        return item.result.value.capabilities
      })
      return workspaceCapabilityCatalogSchema.parse({ workspaceId: id, modules: outcomes, capabilities })
    },
    invoke: invokeCapability,
    presets: () => PRESET_CATALOG,
    applyPreset: async (rawId, presetId, access) => {
      const id = workspaceIdSchema.parse(rawId)
      requireWorkspace(id)
      const preset = getPreset(presetId)
      if (!preset) throw hostError({ status: 404, code: 'preset_not_found', message: 'Preset not found' })
      const outcomes = await Promise.all(preset.actions.map(async action => {
        try {
          return {
            capabilityId: action.capabilityId,
            status: 'applied' as const,
            result: await invokeCapability(id, action.capabilityId, { input: action.input }, access),
          }
        } catch (error) {
          return {
            capabilityId: action.capabilityId,
            status: 'failed' as const,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }))
      const applied = outcomes.filter(outcome => outcome.status === 'applied').length
      return {
        presetId: preset.id,
        status: applied === outcomes.length ? 'applied' : applied === 0 ? 'failed' : 'partial',
        outcomes,
      }
    },
    installedModuleIds: () => config.modules.list().map(registration => registration.moduleId),
  }
}
