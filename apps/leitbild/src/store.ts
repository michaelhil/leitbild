import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import {
  moduleIdSchema,
  moduleProvisioningStateSchema,
  newWorkspaceId,
  workspaceIdSchema,
  workspaceSchema,
  type ModuleFailure,
  type ModuleId,
  type ModuleProvisioningState,
  type Workspace,
  type WorkspaceId,
} from '@leitbild/contracts'

interface WorkspaceRow {
  readonly id: string
  readonly name: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface ModuleStateRow {
  readonly workspace_id: string
  readonly module_id: string
  readonly status: ModuleProvisioningState['status']
  readonly failure_code: string | null
  readonly failure_message: string | null
  readonly failure_retryable: number | null
  readonly updated_at: string
}

export interface WorkspaceStore {
  readonly count: () => number
  readonly list: () => ReadonlyArray<Workspace>
  readonly get: (id: WorkspaceId) => Workspace | undefined
  readonly create: (input: { readonly name: string | null; readonly moduleIds: ReadonlyArray<ModuleId> }) => Workspace
  readonly rename: (id: WorkspaceId, name: string | null) => Workspace | undefined
  readonly delete: (id: WorkspaceId) => boolean
  readonly setModuleState: (id: WorkspaceId, state: ModuleProvisioningState) => Workspace | undefined
  readonly close: () => void
}

const CURRENT_SCHEMA = 1

const toModuleState = (row: ModuleStateRow): ModuleProvisioningState => moduleProvisioningStateSchema.parse({
  moduleId: row.module_id,
  status: row.status,
  ...(row.failure_code === null || row.failure_message === null || row.failure_retryable === null
    ? {}
    : {
        failure: {
          code: row.failure_code,
          message: row.failure_message,
          retryable: row.failure_retryable === 1,
        },
      }),
  updatedAt: row.updated_at,
})

export const createWorkspaceStore = (path: string): WorkspaceStore => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const database = new Database(path, { create: true, strict: true })
  database.exec('PRAGMA foreign_keys = ON')

  const currentSchema = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
  if (currentSchema === 0) {
    database.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE workspace_modules (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        module_id TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_code TEXT,
        failure_message TEXT,
        failure_retryable INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, module_id)
      );
      PRAGMA user_version = ${CURRENT_SCHEMA};
    `)
  } else if (currentSchema !== CURRENT_SCHEMA) {
    database.close()
    throw new Error(`Unsupported Workspace Host database schema: ${currentSchema}`)
  }

  const countQuery = database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM workspaces')
  const listWorkspacesQuery = database.query<WorkspaceRow, []>('SELECT id, name, created_at, updated_at FROM workspaces ORDER BY created_at, id')
  const getWorkspaceQuery = database.query<WorkspaceRow, [string]>('SELECT id, name, created_at, updated_at FROM workspaces WHERE id = ?')
  const listModuleStatesQuery = database.query<ModuleStateRow, [string]>(`
    SELECT workspace_id, module_id, status, failure_code, failure_message, failure_retryable, updated_at
    FROM workspace_modules WHERE workspace_id = ? ORDER BY module_id
  `)
  const insertWorkspaceQuery = database.query('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
  const updateWorkspaceQuery = database.query('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?')
  const touchWorkspaceQuery = database.query('UPDATE workspaces SET updated_at = ? WHERE id = ?')
  const deleteWorkspaceQuery = database.query('DELETE FROM workspaces WHERE id = ?')
  const upsertModuleStateQuery = database.query(`
    INSERT INTO workspace_modules (
      workspace_id, module_id, status, failure_code, failure_message, failure_retryable, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, module_id) DO UPDATE SET
      status = excluded.status,
      failure_code = excluded.failure_code,
      failure_message = excluded.failure_message,
      failure_retryable = excluded.failure_retryable,
      updated_at = excluded.updated_at
  `)
  const assemble = (row: WorkspaceRow): Workspace => workspaceSchema.parse({
    id: row.id,
    name: row.name,
    modules: listModuleStatesQuery.all(row.id).map(toModuleState),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  const get = (id: WorkspaceId): Workspace | undefined => {
    const row = getWorkspaceQuery.get(id)
    return row === null ? undefined : assemble(row)
  }

  const saveModuleState = database.transaction((workspaceId: WorkspaceId, state: ModuleProvisioningState): void => {
    const failure: ModuleFailure | undefined = state.failure
    upsertModuleStateQuery.run(
      workspaceId,
      state.moduleId,
      state.status,
      failure?.code ?? null,
      failure?.message ?? null,
      failure === undefined ? null : failure.retryable ? 1 : 0,
      state.updatedAt,
    )
    touchWorkspaceQuery.run(state.updatedAt, workspaceId)
  })

  const create = database.transaction((input: { readonly name: string | null; readonly moduleIds: ReadonlyArray<ModuleId> }): Workspace => {
    const id = newWorkspaceId()
    const timestamp = new Date().toISOString()
    insertWorkspaceQuery.run(id, input.name, timestamp, timestamp)
    for (const moduleId of input.moduleIds) {
      upsertModuleStateQuery.run(id, moduleId, 'provisioning', null, null, null, timestamp)
    }
    return get(id)!
  })

  return {
    count: () => countQuery.get()?.count ?? 0,
    list: () => listWorkspacesQuery.all().map(assemble),
    get,
    create: input => create({
      name: input.name,
      moduleIds: input.moduleIds.map(moduleId => moduleIdSchema.parse(moduleId)),
    }),
    rename: (id, name) => {
      const parsedId = workspaceIdSchema.parse(id)
      const timestamp = new Date().toISOString()
      const result = updateWorkspaceQuery.run(name, timestamp, parsedId)
      return result.changes === 0 ? undefined : get(parsedId)
    },
    delete: id => deleteWorkspaceQuery.run(workspaceIdSchema.parse(id)).changes > 0,
    setModuleState: (id, state) => {
      const parsedId = workspaceIdSchema.parse(id)
      if (get(parsedId) === undefined) return undefined
      saveModuleState(parsedId, moduleProvisioningStateSchema.parse(state))
      return get(parsedId)
    },
    close: () => database.close(),
  }
}
