import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import { workspaceModulePaths } from '../paths.ts'
import { createCollabAgentsModuleState } from './module-state.ts'

let home = ''
let originalHome: string | undefined

beforeEach(async () => {
  originalHome = process.env.LEITBILD_HOME
  home = await mkdtemp(join(tmpdir(), 'leitbild-modules-'))
  process.env.LEITBILD_HOME = home
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.LEITBILD_HOME
  else process.env.LEITBILD_HOME = originalHome
  await rm(home, { recursive: true, force: true })
})

describe('Leitbild Module state', () => {
  test('provisions independent strict Collab and Agents shards', async () => {
    const workspaceId = newWorkspaceId()
    const state = createCollabAgentsModuleState()
    expect((await state.provision(workspaceId, 'collab')).created).toBe(true)
    expect((await state.provision(workspaceId, 'collab')).created).toBe(false)
    expect(await state.has(workspaceId, 'agents')).toBe(false)
    await state.provision(workspaceId, 'agents')
    expect([...await state.enabled(workspaceId)].sort()).toEqual(['agents', 'collab'])
  })

  test('removes one Module without deleting the other Module state', async () => {
    const workspaceId = newWorkspaceId()
    const state = createCollabAgentsModuleState()
    await state.provision(workspaceId, 'collab')
    await state.provision(workspaceId, 'agents')
    await Bun.write(workspaceModulePaths(workspaceId).agents.snapshot, '{}')

    await state.remove(workspaceId, 'collab')

    expect(await state.has(workspaceId, 'collab')).toBe(false)
    expect(await state.has(workspaceId, 'agents')).toBe(true)
    expect(await Bun.file(workspaceModulePaths(workspaceId).agents.snapshot).exists()).toBe(true)
  })

  test('rejects corrupt markers instead of inventing Module membership', async () => {
    const workspaceId = newWorkspaceId()
    const state = createCollabAgentsModuleState()
    await state.provision(workspaceId, 'agents')
    await Bun.write(workspaceModulePaths(workspaceId).agents.marker, '{}')
    expect(state.has(workspaceId, 'agents')).rejects.toThrow()
  })
})
