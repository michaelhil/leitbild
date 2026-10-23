import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configureActiveRoleSet, initialRoleSet, roleSetStorageKey, withActiveRoleSet } from '../src/ui/roles/role-session.ts'

// W9.2/W9.3: a Run that declares roles (Halden dispatch, Halden border) answers only a screen that plays one, so an
// embedded view of it (a chat answer's vignette, the display window's) refused to draw: "This Run declares roles;
// pick a role to use it". An embedded view plays its tab's role set, as the World frame that chose it does.
const src = join(import.meta.dir, '../src')

describe('an embedded view of a role Run plays its tab\'s role set', () => {
  test('the role set the tab stored for the Run is the one its requests carry', () => {
    const stored = new Map([[roleSetStorageKey('ws', 'run-1'), JSON.stringify(['controller'])]])
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: () => {}, removeItem: () => {} }
    configureActiveRoleSet(initialRoleSet({ search: '', storage, key: roleSetStorageKey('ws', 'run-1') }))
    expect(withActiveRoleSet('/api/workspaces/ws/world/simulation-runs/run-1/displays/sample')).toBe('/api/workspaces/ws/world/simulation-runs/run-1/displays/sample?roles=controller')
    configureActiveRoleSet(null)
  })

  test('the embed page configures it, and the vignette\'s and the defaults\' requests carry it', () => {
    expect(readFileSync(join(src, 'ui/embed/main.ts'), 'utf8')).toContain("if (envelope.subject.type === 'world.simulation-run') configureActiveRoleSet(initialRoleSet({ search: location.search, storage: sessionStorage, key: roleSetStorageKey(workspaceId, envelope.subject.id) }))")
    expect(readFileSync(join(src, 'ui/embed/vignette/vignette-client.ts'), 'utf8')).toContain('const runPath = (runId: SimulationRunId, suffix: string): string => withActiveRoleSet(workspaceApiPath(')
    expect(readFileSync(join(src, 'ui/process-display/default-display.ts'), 'utf8')).toContain('await fetch(withActiveRoleSet(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/displays/default`)), {')
  })
})
