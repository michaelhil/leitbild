import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { workspaceModulePaths } from '../paths.ts'
import { createSamsinnModuleState } from './module-state.ts'

let home = ''
let originalHome: string | undefined

beforeEach(async () => {
  originalHome = process.env.SAMSINN_HOME
  home = await mkdtemp(join(tmpdir(), 'samsinn-modules-'))
  process.env.SAMSINN_HOME = home
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SAMSINN_HOME
  else process.env.SAMSINN_HOME = originalHome
  await rm(home, { recursive: true, force: true })
})

describe('Samsinn Module state', () => {
  test('provisions independent strict Collaboration and Agents shards', async () => {
    const workspaceId = newWorkspaceId()
    const state = createSamsinnModuleState()
    expect((await state.provision(workspaceId, 'collaboration')).created).toBe(true)
    expect((await state.provision(workspaceId, 'collaboration')).created).toBe(false)
    expect(await state.has(workspaceId, 'agents')).toBe(false)
    await state.provision(workspaceId, 'agents')
    expect([...await state.enabled(workspaceId)].sort()).toEqual(['agents', 'collaboration'])
  })

  test('removes one Module without deleting the other Module state', async () => {
    const workspaceId = newWorkspaceId()
    const state = createSamsinnModuleState()
    await state.provision(workspaceId, 'collaboration')
    await state.provision(workspaceId, 'agents')
    await Bun.write(workspaceModulePaths(workspaceId).agents.snapshot, '{}')

    await state.remove(workspaceId, 'collaboration')

    expect(await state.has(workspaceId, 'collaboration')).toBe(false)
    expect(await state.has(workspaceId, 'agents')).toBe(true)
    expect(await Bun.file(workspaceModulePaths(workspaceId).agents.snapshot).exists()).toBe(true)
  })

  test('rejects corrupt markers instead of inventing Module membership', async () => {
    const workspaceId = newWorkspaceId()
    const state = createSamsinnModuleState()
    await state.provision(workspaceId, 'agents')
    await Bun.write(workspaceModulePaths(workspaceId).agents.marker, '{}')
    expect(state.has(workspaceId, 'agents')).rejects.toThrow()
  })
})
