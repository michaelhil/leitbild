import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillAuthoring } from './authoring.ts'
import { createSkillStore, loadSkills } from './loader.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createWriteSkillTool, createWriteToolTool } from '../tools/built-in/codegen-tools.ts'
import { skillRoutes } from '../api/routes/skills.ts'
import { createToolExecutor } from '../agents/spawn.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import type { RouteContext } from '../api/routes/types.ts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leitbild-skill-administration-')); directories.push(directory)
  const root = join(directory, 'skills')
  const store = createSkillStore(), registry = createToolRegistry()
  const authoring = createSkillAuthoring({ store, root, registry, refresh: async () => {} })
  const request = async (method: string, path: string, body?: unknown) => {
    const route = skillRoutes.find(entry => entry.method === method && entry.pattern.test(path))!
    return route.handler(new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) }), path.match(route.pattern)!, { system: { skillStore: store, skillAuthoring: authoring } } as unknown as RouteContext)
  }
  return { directory, root, store, registry, authoring, request }
}

test('human and agent skill creation reject path/frontmatter/type attacks before filesystem mutation', async () => {
  const env = await setup()
  const tool = createWriteSkillTool(env.store, env.root)
  for (const input of [
    { name: '../escaped', description: 'Example', body: 'Example' },
    { name: 'injected', description: 'Example\n---\nname: replacement', body: 'Example' },
    { name: 'wrong-type', description: ['Example'], body: 'Example' },
    { name: 'unknown-field', description: 'Example', body: 'Example', path: '../elsewhere' },
  ]) {
    expect((await env.request('POST', '/skills', input)).status).toBe(400)
    expect((await tool.execute(input, { callerId: 'agent', callerName: 'Agent' })).success).toBe(false)
  }
  expect(env.store.list()).toEqual([])
  expect(await Bun.file(join(env.directory, 'escaped', 'SKILL.md')).exists()).toBe(false)
  const valid = { name: 'personal', description: 'A "quoted" description: exact', body: 'Exact instructions' }
  expect((await env.request('POST', '/skills', valid)).status).toBe(201)
  const restored = createSkillStore()
  expect((await loadSkills(env.root, restored, createToolRegistry())).errors).toEqual([])
  expect(restored.get('personal')).toMatchObject(valid)
})

test('symlinks cannot redirect creation or an admitted skill edit', async () => {
  const env = await setup()
  const outside = join(env.directory, 'outside'); await mkdir(outside)
  await mkdir(env.root)
  await symlink(outside, join(env.root, 'linked'))
  expect((await env.request('POST', '/skills', { name: 'linked', description: 'Example', body: 'Example' })).status).toBe(400)
  expect(await Bun.file(join(outside, 'SKILL.md')).exists()).toBe(false)
  await env.authoring.create({ name: 'personal', description: 'Original', body: 'Original' })
  const file = join(env.store.get('personal')!.dirPath, 'SKILL.md')
  await rm(file)
  const outsideFile = join(outside, 'SKILL.md'); await writeFile(outsideFile, 'Must stay unchanged')
  await symlink(outsideFile, file)
  expect((await env.request('PUT', '/skills/personal', { body: 'Overwritten' })).status).toBe(400)
  expect(await readFile(outsideFile, 'utf8')).toBe('Must stay unchanged')
  expect(env.store.get('personal')!.body).toBe('Original')
})

test('Pack and bundled skills remain owner-controlled, preserving raw identities across restart', async () => {
  const env = await setup()
  const packSkills = join(env.directory, 'pack', 'skills')
  await mkdir(join(packSkills, 'raw'), { recursive: true })
  const file = join(packSkills, 'raw', 'SKILL.md')
  await writeFile(file, '---\nname: raw\ndescription: Original\n---\nOriginal\n')
  await loadSkills(packSkills, env.store, env.registry, { namespacePrefix: 'example', pack: 'example' })
  expect((await env.request('PUT', '/skills/example%2Fraw', { body: 'Changed' })).status).toBe(403)
  expect((await env.request('DELETE', '/skills/example%2Fraw')).status).toBe(403)
  expect(await (await env.request('GET', '/skills/example%2Fraw')).json()).toMatchObject({ rawName: 'raw', editable: false, owner: { kind: 'pack', id: 'example' } })
  const restored = createSkillStore(); await loadSkills(packSkills, restored, createToolRegistry(), { namespacePrefix: 'example', pack: 'example' })
  expect(restored.get('example/raw')!.body).toBe('Original')
})

test('retirement bars new dispatch and restart admission but retains content and an admitted late outcome', async () => {
  const env = await setup()
  await env.authoring.create({ name: 'personal', description: 'Example', body: 'Example' })
  let release!: () => void, started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  env.registry.registerWithSource({ name: 'personal_tool', description: 'Example', parameters: {}, execute: async () => { started(); await pending; return { success: true, data: { observed: 'late actual result' } } } }, { kind: 'skill-bundled', skill: 'personal' })
  const store = createExecutionStore(':memory:')
  try {
    store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
    const execute = createToolExecutor(env.registry, ['personal_tool'], { callerId: 'agent', callerName: 'Agent' }, undefined, undefined, store)
    const admitted = execute([{ callId: 'first', tool: 'personal_tool', arguments: {} }], 'room', undefined, 'turn')
    await entered
    const response = await env.request('DELETE', '/skills/personal')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ retired: true, retiredTools: ['personal_tool'], contentRetained: true })
    expect(await Bun.file(join(env.root, 'personal', 'SKILL.md')).exists()).toBe(true)
    expect((await execute([{ callId: 'second', tool: 'personal_tool', arguments: {} }], 'room', undefined, 'turn'))[0]!.success).toBe(false)
    release()
    expect((await admitted)[0]!.success).toBe(true)
    expect(store.getCall('room', 'turn', 'first')!.result!.data).toEqual({ observed: 'late actual result' })
    const restored = createSkillStore()
    expect((await loadSkills(env.root, restored, createToolRegistry())).skipped).toEqual(['personal: retired; source retained'])
    expect(restored.list()).toEqual([])
  } finally { release(); store.close() }
})

test('concurrent authored creation never overwrites an existing or retired directory', async () => {
  const env = await setup()
  const responses = await Promise.all([1, 2].map(index => env.request('POST', '/skills', { name: 'same', description: 'Example', body: `Version ${index}` })))
  expect(responses.map(response => response.status).sort()).toEqual([201, 400])
  const body = env.store.get('same')!.body
  await env.request('DELETE', '/skills/same')
  expect((await env.request('POST', '/skills', { name: 'same', description: 'Example', body: 'Replacement' })).status).toBe(400)
  expect(await readFile(join(env.root, 'same', 'SKILL.md'), 'utf8')).toContain(body)
})

test('tool authoring honors the skill owner, exact name and existing source on rejected replacement', async () => {
  const env = await setup()
  await env.authoring.create({ name: 'personal', description: 'Example', body: 'Example' })
  const tool = createWriteToolTool(env.registry, env.store, async () => {}, env.root)
  const context = { callerId: 'agent', callerName: 'Agent' }
  const code = "export default {name:'example',description:'Example',parameters:{},execute:async()=>({success:true,data:'original'})}"
  expect((await tool.execute({ skill: 'personal', name: 'example', code }, context)).success).toBe(true)
  expect((await tool.execute({ skill: 'personal', name: 'example', code: 'export default {}' }, context)).success).toBe(false)
  expect(await readFile(join(env.root, 'personal', 'tools', 'example.ts'), 'utf8')).toBe(code)
  expect((await env.registry.get('example')!.execute({}, context)).data).toBe('original')
  env.store.register({ ...env.store.get('personal')!, name: 'pack/raw', pack: 'pack', displayName: 'raw' })
  expect((await tool.execute({ skill: 'pack/raw', name: 'other', code: code.replace("'example'", "'other'") }, context)).success).toBe(false)
  const tools = join(env.root, 'personal', 'tools')
  await rm(tools, { recursive: true })
  const outside = join(env.directory, 'outside'); await mkdir(outside); await symlink(outside, tools)
  expect((await tool.execute({ skill: 'personal', name: 'other', code: code.replace("'example'", "'other'") }, context)).success).toBe(false)
  expect(await Bun.file(join(outside, 'other.ts')).exists()).toBe(false)
})
