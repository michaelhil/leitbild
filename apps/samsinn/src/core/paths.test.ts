import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  assertValidWorkspaceId,
  isValidWorkspaceId,
  samsinnHome,
  sharedPaths,
  workspaceModulePaths,
} from './paths.ts'

const workspaceId = workspaceIdSchema.parse('9d2bd146-dc4a-4cbf-9754-f966884c5ca9')
let originalHome: string | undefined

beforeEach(() => { originalHome = process.env.SAMSINN_HOME })
afterEach(() => {
  if (originalHome === undefined) delete process.env.SAMSINN_HOME
  else process.env.SAMSINN_HOME = originalHome
})

describe('Samsinn path policy', () => {
  it('defaults to ~/.samsinn and accepts an explicit home', () => {
    delete process.env.SAMSINN_HOME
    expect(samsinnHome()).toBe(join(homedir(), '.samsinn'))
    process.env.SAMSINN_HOME = '/var/lib/samsinn'
    expect(samsinnHome()).toBe('/var/lib/samsinn')
  })

  it('keeps deployment and Workspace roots separate', () => {
    process.env.SAMSINN_HOME = '/tmp/x'
    expect(sharedPaths.providers()).toBe('/tmp/x/providers.json')
    expect(sharedPaths.packs()).toBe('/tmp/x/packs')
    expect(sharedPaths.workspacesRoot()).toBe('/tmp/x/workspaces')
  })

  it('places Samsinn state in the Workspace-owned module shard', () => {
    process.env.SAMSINN_HOME = '/tmp/x'
    const paths = workspaceModulePaths(workspaceId)
    expect(paths.root).toBe(`/tmp/x/workspaces/${workspaceId}`)
    expect(paths.collaboration.snapshot).toBe(`/tmp/x/workspaces/${workspaceId}/collaboration/snapshot.json`)
    expect(paths.collaboration.documents).toBe(`/tmp/x/workspaces/${workspaceId}/collaboration/documents`)
    expect(paths.agents.snapshot).toBe(`/tmp/x/workspaces/${workspaceId}/agents/snapshot.json`)
    expect(paths.agents.memory).toBe(`/tmp/x/workspaces/${workspaceId}/agents/memory`)
    expect(paths.agents.vectors).toBe(`/tmp/x/workspaces/${workspaceId}/agents/vectors.jsonl`)
  })

  it('rejects non-UUID and traversal-shaped identifiers', () => {
    expect(isValidWorkspaceId(workspaceId)).toBe(true)
    expect(isValidWorkspaceId('../etc')).toBe(false)
    expect(() => assertValidWorkspaceId('../etc')).toThrow()
  })
})
