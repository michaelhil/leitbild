import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { newWorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { createMicroworldModuleState } from './module-state.ts'
import { microworldWorkspacePaths } from './paths.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const createState = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'microworld-module-state-'))
  temporaryDirectories.push(dataDir)
  return { dataDir, state: createMicroworldModuleState({ dataDir }) }
}

describe('Microworld Module state', () => {
  test('provisions strict Host-supplied Workspace markers idempotently', async () => {
    const { state } = await createState()
    const workspaceId = newWorkspaceId()
    expect((await state.provision(workspaceId)).created).toBe(true)
    expect((await state.provision(workspaceId)).created).toBe(false)
    expect((await state.get(workspaceId))?.moduleId).toBe('microworld')
    expect((await state.list()).map(marker => marker.workspaceId)).toEqual([workspaceId])
  })

  test('removes only the Microworld shard', async () => {
    const { dataDir, state } = await createState()
    const workspaceId = newWorkspaceId()
    await state.provision(workspaceId)
    const paths = microworldWorkspacePaths(dataDir, workspaceId)
    await Bun.write(join(paths.workspaceRoot, 'agents', 'workspace.json'), '{}')

    expect(await state.remove(workspaceId)).toBe(true)
    expect(await Bun.file(paths.root).exists()).toBe(false)
    expect(await Bun.file(join(paths.workspaceRoot, 'agents', 'workspace.json')).exists()).toBe(true)
  })

  test('rejects corrupt markers instead of inventing Module membership', async () => {
    const { dataDir, state } = await createState()
    const workspaceId = newWorkspaceId()
    await state.provision(workspaceId)
    await Bun.write(microworldWorkspacePaths(dataDir, workspaceId).marker, '{}')
    expect(state.get(workspaceId)).rejects.toThrow()
  })
})
