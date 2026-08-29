import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  assertValidWorkspaceId,
  isValidWorkspaceId,
  leitbildHome,
  sharedPaths,
  workspaceModulePaths,
} from './paths.ts'

const workspaceId = workspaceIdSchema.parse('9d2bd146-dc4a-4cbf-9754-f966884c5ca9')
let originalHome: string | undefined

beforeEach(() => { originalHome = process.env.LEITBILD_HOME })
afterEach(() => {
  if (originalHome === undefined) delete process.env.LEITBILD_HOME
  else process.env.LEITBILD_HOME = originalHome
})

describe('Leitbild path policy', () => {
  it('defaults to ~/.leitbild and accepts an explicit home', () => {
    delete process.env.LEITBILD_HOME
    expect(leitbildHome()).toBe(join(homedir(), '.leitbild'))
    process.env.LEITBILD_HOME = '/var/lib/leitbild'
    expect(leitbildHome()).toBe('/var/lib/leitbild')
  })

  it('keeps deployment and Workspace roots separate', () => {
    process.env.LEITBILD_HOME = '/tmp/x'
    expect(sharedPaths.providers()).toBe('/tmp/x/providers.json')
    expect(sharedPaths.packs()).toBe('/tmp/x/packs')
    expect(sharedPaths.workspacesRoot()).toBe('/tmp/x/workspaces')
  })

  it('places Leitbild state in the Workspace-owned module shard', () => {
    process.env.LEITBILD_HOME = '/tmp/x'
    const paths = workspaceModulePaths(workspaceId)
    expect(paths.root).toBe(`/tmp/x/workspaces/${workspaceId}`)
    expect(paths.collab.snapshot).toBe(`/tmp/x/workspaces/${workspaceId}/collab/snapshot.json`)
    expect(paths.collab.documents).toBe(`/tmp/x/workspaces/${workspaceId}/collab/documents`)
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
