import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import type { Skill } from '../../skills/loader.ts'
import type { SkillAuthoring } from '../../skills/authoring.ts'

const detail = (skill: Skill, authoring: SkillAuthoring) => ({
  name: skill.name, rawName: skill.displayName ?? skill.name,
  description: skill.description, body: skill.body, tools: skill.tools,
  allowedToolNames: skill.allowedToolNames,
  owner: skill.pack ? { kind: 'pack', id: skill.pack } : { kind: authoring.editable(skill) ? 'authored' : 'bundled' },
  editable: authoring.editable(skill),
})
const failure = (error: unknown): Response => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'invalid_skill_input'
  return json({ error: error instanceof Error ? error.message : String(error), code }, code === 'skill_not_found' ? 404 : code === 'skill_owner_read_only' ? 403 : 400)
}
export const skillRoutes: RouteEntry[] = [
  { method: 'GET', pattern: /^\/skills$/, handler: (_req, _match, { system }) => json(system.skillStore.list().map(skill => detail(skill, system.skillAuthoring))) },
  { method: 'GET', pattern: /^\/skills\/([^/]+)$/, handler: (_req, match, { system }) => {
    const skill = system.skillStore.get(decodeURIComponent(match[1]!))
    return skill ? json(detail(skill, system.skillAuthoring)) : errorResponse('Skill not found', 404)
  } },
  { method: 'POST', pattern: /^\/skills$/, handler: async (req, _match, { system }) => {
    try { const skill = await system.skillAuthoring.create(await parseBody(req)); return json({ created: true, name: skill.name }, 201) } catch (error) { return failure(error) }
  } },
  { method: 'PUT', pattern: /^\/skills\/([^/]+)$/, handler: async (req, match, { system }) => {
    try { const skill = await system.skillAuthoring.update(decodeURIComponent(match[1]!), await parseBody(req)); return json({ updated: true, name: skill.name }) } catch (error) { return failure(error) }
  } },
  { method: 'DELETE', pattern: /^\/skills\/([^/]+)$/, handler: async (_req, match, { system }) => {
    try { return json({ retired: true, ...await system.skillAuthoring.retire(decodeURIComponent(match[1]!)) }) } catch (error) { return failure(error) }
  } },
]
