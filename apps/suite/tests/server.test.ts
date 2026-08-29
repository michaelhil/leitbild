import { afterEach, describe, expect, test } from 'bun:test'
import { createSuiteServer } from '../src/server.ts'
import type { SuiteCoordinator } from '../src/coordinator.ts'

const servers: Array<ReturnType<typeof createSuiteServer>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe('suite server', () => {
  test('uses relative API links so the UI works at / and behind /suite/', async () => {
    const coordinator: SuiteCoordinator = {
      list: async () => [],
      get: async () => undefined,
      create: async () => { throw new Error('not used') },
      provision: async () => { throw new Error('not used') },
    }
    const server = createSuiteServer({ coordinator, port: 0, bindHost: '127.0.0.1' })
    servers.push(server)

    const html = await fetch(`http://127.0.0.1:${server.port}/`).then(response => response.text())
    expect(html).toContain("fetch('api/workspaces'")
    expect(html).toContain("fetch('api/workspaces/'")
    expect(html).not.toContain("fetch('/api/workspaces")
  })
})
