import { constants, realpathSync } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ToolRegistry } from '../core/types/tool.ts'
import { createSerialiseChain, type SerialiseChain } from '../core/serialise-chain.ts'
import type { Skill, SkillStore } from './loader.ts'

export const RETIRED_SKILL_MARKER = '.retired'
const nameSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)
const descriptionSchema = z.string().trim().min(1).max(4096).refine(value => !/[\r\n]/.test(value), 'description must be one line')
export const createSkillSchema = z.object({ name: nameSchema, description: descriptionSchema, body: z.string().min(1), allowedToolNames: z.array(nameSchema).optional() }).strict()
const updateSkillSchema = createSkillSchema.omit({ name: true }).partial()
const chains = new WeakMap<SkillStore, SerialiseChain>()
const chainFor = (store: SkillStore): SerialiseChain => {
  let chain = chains.get(store)
  if (!chain) { chain = createSerialiseChain(); chains.set(store, chain) }
  return chain
}
const refused = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }
const rootPath = async (root: string): Promise<string> => {
  await mkdir(root, { recursive: true })
  if ((await lstat(root)).isSymbolicLink()) refused('skill_path_invalid', 'Authored skills root must not be a symlink')
  return realpath(root)
}
const render = (skill: Pick<Skill, 'name' | 'description' | 'body' | 'allowedToolNames'>): string =>
  `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n${skill.allowedToolNames.length ? `allowed-tools: [${skill.allowedToolNames.join(', ')}]\n` : ''}---\n\n${skill.body}\n`
const editablePath = async (root: string, skill: Skill): Promise<string> => {
  if (skill.pack || !nameSchema.safeParse(skill.name).success) refused('skill_owner_read_only', 'Pack skills are changed through their Pack owner; create an authored copy to edit')
  const canonicalRoot = await rootPath(root)
  const directory = join(canonicalRoot, skill.name)
  if (await realpath(skill.dirPath) !== directory || (await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) {
    refused('skill_owner_read_only', 'Only skills in the authored skills directory can be edited or retired')
  }
  if ((await lstat(join(directory, 'SKILL.md'))).isSymbolicLink()) refused('skill_path_invalid', 'SKILL.md must not be a symlink')
  return directory
}
const writeExclusive = async (path: string, content: string): Promise<void> => {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(content, 'utf8'); await file.sync() } finally { await file.close() }
}

/** Deployment-owned authored skills. Pack/bundled source is never edited here.
 * Retirement leaves content and admitted closures in place; the marker prevents
 * re-admission on restart. Selecting/deselecting guidance is unrelated authority.
 */
export const createAuthoredSkill = (store: SkillStore, root: string, raw: unknown): Promise<Skill> => chainFor(store).run(async () => {
  const input = createSkillSchema.parse(raw)
  if (store.get(input.name)) refused('skill_exists', `Skill "${input.name}" already exists`)
  const directory = join(await rootPath(root), input.name)
  // No recursive mkdir: an existing directory (including a symlink or retired
  // content) is never adopted or overwritten by a new authoring request.
  await mkdir(directory)
  const skill: Skill = { ...input, allowedToolNames: input.allowedToolNames ?? [], tools: [], dirPath: directory }
  try { await writeExclusive(join(directory, 'SKILL.md'), render(skill)) }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  store.register(skill)
  return skill
})

export const withAuthoredSkill = <T>(store: SkillStore, root: string, name: string, work: (skill: Skill, directory: string) => Promise<T>): Promise<T> => chainFor(store).run(async () => {
  const skill = store.get(name)
  if (!skill) return refused('skill_not_found', `Skill "${name}" not found`)
  return work(skill, await editablePath(root, skill))
})

export const createSkillAuthoring = (deps: { store: SkillStore; root: string; registry: ToolRegistry; refresh: () => Promise<void> }) => ({
  create: (input: unknown) => createAuthoredSkill(deps.store, deps.root, input),
  editable: (skill: Skill): boolean => {
    if (skill.pack || !nameSchema.safeParse(skill.name).success) return false
    try { return realpathSync(skill.dirPath) === join(realpathSync(deps.root), skill.name) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false // Unavailable source is never editable.
      throw error
    }
  },
  update: (name: string, raw: unknown): Promise<Skill> => chainFor(deps.store).run(async () => {
    const patch = updateSkillSchema.parse(raw)
    const skill = deps.store.get(name)
    if (!skill) return refused('skill_not_found', `Skill "${name}" not found`)
    const directory = await editablePath(deps.root, skill)
    const updated = { ...skill, ...patch }
    const temporary = join(directory, `.SKILL.${crypto.randomUUID()}.tmp`)
    try { await writeExclusive(temporary, render(updated)); await editablePath(deps.root, skill); await rename(temporary, join(directory, 'SKILL.md')) }
    finally { await rm(temporary, { force: true }) }
    deps.store.register(updated)
    return updated
  }),
  retire: (name: string): Promise<{ name: string; retiredTools: string[]; contentRetained: true }> => chainFor(deps.store).run(async () => {
    const skill = deps.store.get(name)
    if (!skill) return refused('skill_not_found', `Skill "${name}" not found`)
    const directory = await editablePath(deps.root, skill)
    await writeExclusive(join(directory, RETIRED_SKILL_MARKER), 'Retired through authored skill administration. Content retained.\n')
    const retiredTools = deps.registry.listEntries().filter(entry => entry.source.kind === 'skill-bundled' && entry.source.skill === name).map(entry => entry.tool.name)
    for (const tool of retiredTools) deps.registry.unregister(tool)
    deps.store.remove(name)
    await deps.refresh()
    return { name, retiredTools, contentRetained: true }
  }),
})
export type SkillAuthoring = ReturnType<typeof createSkillAuthoring>
