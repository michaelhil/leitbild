import {
  createWorkspaceInputSchema,
  moduleIdSchema,
  moduleMembershipSchema,
  renameWorkspaceInputSchema,
  workspaceIdSchema,
  type CreateWorkspaceInput,
  type ModuleId,
  type ModuleMembership,
  type RenameWorkspaceInput,
  type Workspace,
  type WorkspaceId,
} from '@samsinn-leitbild/platform-contracts'
import { hostError } from './errors.ts'
import type { ModuleGateway, ModuleOperationResult } from './module-gateway.ts'
import type { WorkspaceStore } from './store.ts'

export interface WorkspaceHost {
  readonly list: () => ReadonlyArray<Workspace>
  readonly get: (id: WorkspaceId) => Workspace | undefined
  readonly create: (input: CreateWorkspaceInput) => Promise<Workspace>
  readonly rename: (id: WorkspaceId, input: RenameWorkspaceInput) => Workspace
  readonly delete: (id: WorkspaceId) => Promise<void>
  readonly addModule: (id: WorkspaceId, moduleId: ModuleId) => Promise<Workspace>
  readonly removeModule: (id: WorkspaceId, moduleId: ModuleId) => Promise<Workspace>
  readonly retryModule: (id: WorkspaceId, moduleId: ModuleId) => Promise<Workspace>
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

  const leave = async (workspaceId: WorkspaceId, moduleId: ModuleId): Promise<Workspace> => {
    const result = await config.modules.leave(moduleId, workspaceId)
    if (result.ok) return config.store.removeMembership(workspaceId, moduleId)!
    return config.store.setMembership(workspaceId, membership(moduleId, 'leave_failed', result))!
  }

  return {
    list: config.store.list,
    get: config.store.get,
    create: async rawInput => {
      const input = createWorkspaceInputSchema.parse(rawInput)
      const moduleIds = input.moduleIds ?? []
      for (const moduleId of moduleIds) requireInstalledModule(moduleId)
      const workspace = config.store.create({ name: input.name ?? null, moduleIds })
      await Promise.all(moduleIds.map(moduleId => join(workspace.id, moduleId)))
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
    addModule: async (rawId, rawModuleId) => {
      const id = workspaceIdSchema.parse(rawId)
      const moduleId = moduleIdSchema.parse(rawModuleId)
      const workspace = requireWorkspace(id)
      requireInstalledModule(moduleId)
      if (workspace.modules.some(item => item.moduleId === moduleId)) {
        throw hostError({ status: 409, code: 'module_already_joined', message: `Module already belongs to Workspace: ${moduleId}` })
      }
      config.store.setMembership(id, membership(moduleId, 'joining'))
      return await join(id, moduleId)
    },
    removeModule: async (rawId, rawModuleId) => {
      const id = workspaceIdSchema.parse(rawId)
      const moduleId = moduleIdSchema.parse(rawModuleId)
      const workspace = requireWorkspace(id)
      if (!workspace.modules.some(item => item.moduleId === moduleId)) {
        throw hostError({ status: 404, code: 'module_membership_not_found', message: `Module does not belong to Workspace: ${moduleId}` })
      }
      config.store.setMembership(id, membership(moduleId, 'leaving'))
      const result = await leave(id, moduleId)
      const failed = result.modules.find(item => item.moduleId === moduleId && item.status === 'leave_failed')
      if (failed) {
        throw hostError({
          status: 502,
          code: 'module_leave_failed',
          message: failed.failure!.message,
          retryable: failed.failure!.retryable,
          details: { moduleId },
        })
      }
      return result
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
      if (existing.status === 'leave_failed') {
        config.store.setMembership(id, membership(moduleId, 'leaving'))
        return await leave(id, moduleId)
      }
      throw hostError({ status: 409, code: 'module_not_retryable', message: `Module lifecycle is not failed: ${moduleId}` })
    },
    installedModuleIds: () => config.modules.list().map(registration => registration.moduleId),
  }
}
