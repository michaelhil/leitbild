import { afterEach, expect, test } from 'bun:test'
import { createAgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentPackDescriptor, parsePackManifest } from '../packs/manifest.ts'
import { buildToolSupport } from '../agents/spawn.ts'
import { SYSTEM_SENDER_ID } from '../core/types/constants.ts'
import { getBundledRoomDefinition } from '../core/definitions/room-definition-catalog.ts'
import { PWR_OPS_TOOLS } from '../packs/pwr-ops/index.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('real Workspace registration reads only current active reference Packs through selected Agent tool surface', async () => {
  const deployment = createDeploymentRuntime()
  const system = createAgentsWorkspaceRuntime({ deployment })
  const room = system.rooms.createRoom({ name: 'Reference room', createdBy: SYSTEM_SENDER_ID })
  const otherRoom = system.rooms.createRoom({ name: 'Other room', createdBy: SYSTEM_SENDER_ID })
  const manifest = parsePackManifest({
    descriptor: createAgentPackDescriptor({ id: 'engineering', version: '1.0.0', name: 'Engineering', description: 'Fixture references', contributions: [{ kind: 'wiki' }] }),
    wikis: [{ name: 'Thermal engineering', url: 'https://engineering.test/', source: { org: 'fixture', repo: 'engineering', branch: 'main', citationBase: 'https://engineering.test/', manifestUrl: 'https://engineering.test/manifest.json' } }],
    uiExtensions: [],
  })
  deployment.packCatalog.replaceInstalled([{ id: 'engineering', dirPath: '/test-only/engineering', manifest }])
  const revision = 'a'.repeat(40)
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input.toString()
    calls.push(url)
    if (url === 'https://engineering.test/manifest.json') return Response.json({ version: 1, wiki: 'engineering', revision, procedures: [], pages: [
      { id: 'cooling', type: 'handbook', title: 'Cooling', file: 'notes/cooling.md' },
    ] })
    if (url === `https://raw.githubusercontent.com/fixture/engineering/${revision}/notes/cooling.md`) return new Response('# Cooling\nA reference is not a measurement.\n')
    throw new Error(`unexpected external request: ${url}`)
  }) as typeof fetch
  const definition = getBundledRoomDefinition('leitbild-assistant')!
  expect(definition.room.packs).toEqual([])
  expect(definition.room.agents[0]!.tools).toContain('wiki_lookup')
  expect(PWR_OPS_TOOLS.some(tool => tool.name === 'wiki_lookup')).toBe(false)
  const support = await buildToolSupport(['wiki_lookup'], system.toolRegistry,
    { id: 'reader', name: 'Reader' }, system.llm, id => system.rooms.getRoom(id))
  const invoke = async (arguments_: Record<string, unknown>, roomId = room.profile.id) =>
    (await support.toolExecutor!([{ tool: 'wiki_lookup', arguments: arguments_ }], roomId))[0]!
  expect(await invoke({})).toMatchObject({ success: true, data: { sources: [], total: 0 } })
  expect(calls).toEqual([])
  room.setActivePacks(['engineering'])
  const names = support.resolveToolDefinitions!(room.profile.id)!.map(tool => tool.function.name)
  expect(names).toContain('wiki_lookup')
  expect(names.some(name => /procedure|eal/.test(name))).toBe(false)
  const index = await invoke({ packId: 'engineering', wikiUrl: 'https://engineering.test/' })
  expect(index).toMatchObject({ success: true, data: { pages: [{ id: 'cooling', type: 'handbook' }] } })
  const read = (index.data as { pages: Array<{ read: Record<string, unknown> }> }).pages[0]!.read
  expect(await invoke(read)).toMatchObject({ success: true, data: { markdown: '# Cooling\nA reference is not a measurement.\n', source: { revision } } })
  expect(calls).toHaveLength(2)
  expect(await invoke({}, otherRoom.profile.id)).toMatchObject({ success: true, data: { sources: [], total: 0 } })
  room.setActivePacks([])
  expect(await invoke(read)).toMatchObject({ success: false, error: expect.stringContaining('wiki_source_unavailable') })
  room.setActivePacks(['engineering'])
  deployment.packCatalog.replaceInstalled([])
  expect(await invoke(read)).toMatchObject({ success: false, error: expect.stringContaining('wiki_source_unavailable') })
  expect(calls).toHaveLength(2)
})
