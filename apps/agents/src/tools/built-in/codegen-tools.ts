import { createAuthoredSkill, withAuthoredSkill } from '../../skills/authoring.ts'
// ============================================================================
// Code Generation Tools — Runtime skill and tool authoring by agents.
//
// write_skill: Creates a skill directory with SKILL.md.
// write_tool: Writes a complete .ts module into a skill's tools/ directory.
// test_tool: Runs a registered tool with sample input.
// list_skills: Lists all loaded skills with their bundled tools.
//
// Code generation intelligence lives in the skill-builder skill
// (skills/skill-builder/tools/generate_tool_code.ts), not here.
// These tools are mechanical — filesystem, registry, validation.
// ============================================================================

import type { Tool, ToolRegistry } from '../../core/types/tool.ts'
import type { SkillStore } from '../../skills/loader.ts'
import { VALID_NAME, isTool } from '../loader.ts'
import { mkdir, lstat, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

type RefreshAllFn = () => Promise<void>

export const createWriteSkillTool = (
  store: SkillStore,
  skillsDir: string,
): Tool => ({
  name: 'write_skill',
  description: 'Create a SKILL.md — a behavioural prompt template injected into agent context. Bundled tools come later via write_tool.',
  usage: 'Create reusable behavioural instructions. Body is markdown. Add bundled tools later with write_tool.',
  returns: 'Object with the skill name and directory path.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
      description: { type: 'string', description: 'When this skill should be used' },
      body: { type: 'string', description: 'Markdown body' },
    },
    required: ['name', 'description', 'body'],
  },
  execute: async (params) => {
    try {
      const skill = await createAuthoredSkill(store, skillsDir, params)
      return { success: true, data: { name: skill.name, path: skill.dirPath } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
})

export const createWriteToolTool = (
  registry: ToolRegistry,
  store: SkillStore,
  refreshAll: RefreshAllFn,
  skillsDir: string,
): Tool => ({
  name: 'write_tool',
  description: 'Write a TypeScript tool module into a skill\'s tools/ dir. Imported, validated, and registered immediately.',
  usage: 'Use after generate_tool_code has produced the source code. Pass the code string directly — do not modify it. The code must be a complete .ts module that exports a tool object as default.',
  returns: 'Object with the registered tool name, skill, and file path.',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Owning skill (must exist).' },
      name: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
      code: { type: 'string', description: 'Complete .ts module exporting a Tool as default.' },
    },
    required: ['skill', 'name', 'code'],
  },
  execute: async (params) => {
    try {
      const input = z.object({ skill: z.string().min(1), name: z.string().regex(VALID_NAME), code: z.string().min(1) }).strict().parse(params)
      return await withAuthoredSkill(store, skillsDir, input.skill, async (skill, directory) => {
        const prior = registry.getEntry(input.name)
        if (prior && (prior.source.kind !== 'skill-bundled' || prior.source.skill !== input.skill)) return { success: false, error: `Tool "${input.name}" belongs to another owner` }
        const toolsDir = join(directory, 'tools')
        await mkdir(toolsDir, { recursive: true })
        if ((await lstat(toolsDir)).isSymbolicLink() || await realpath(toolsDir) !== toolsDir) return { success: false, error: 'Skill tools directory must not be a symlink' }
        const filePath = join(toolsDir, `${input.name}.ts`)
        const temporary = join(toolsDir, `.candidate-${crypto.randomUUID()}.ts`)
        try {
          await writeFile(temporary, input.code, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
          // Codegen is explicitly enabled in-process code execution, not a sandbox.
          const mod = await import(temporary) as { default?: unknown }
          if (!isTool(mod.default) || mod.default.name !== input.name) return { success: false, error: 'Generated tool must export the exact requested name, description, parameters and execute function' }
          await rename(temporary, filePath)
          registry.registerWithSource(mod.default, { kind: 'skill-bundled', skill: input.skill, path: filePath })
          if (!skill.tools.includes(input.name)) store.register({ ...skill, tools: [...skill.tools, input.name] })
          await refreshAll()
          return { success: true, data: { name: input.name, skill: input.skill, path: filePath } }
        } finally { await rm(temporary, { force: true }) }
      })
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  },
})

export const createTestToolTool = (
  registry: ToolRegistry,
): Tool => ({
  name: 'test_tool',
  description: 'Run a registered tool with sample input. Verifies a freshly-authored tool works.',
  returns: 'The tool\'s result — either { success: true, data: ... } or { success: false, error: "..." }.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      input: { type: 'object' },
    },
    required: ['name', 'input'],
  },
  execute: async (params, context) => {
    const name = params.name as string
    const input = params.input as Record<string, unknown>

    if (!name) return { success: false, error: 'name is required' }

    const tool = registry.get(name)
    if (!tool) return { success: false, error: `Tool "${name}" not found in registry` }

    try {
      return await tool.execute(input ?? {}, context)
    } catch (err) {
      return { success: false, error: `Tool threw: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
})

export const createListSkillsTool = (store: SkillStore): Tool => ({
  name: 'list_skills',
  description: 'List loaded skills with their descriptions and bundled tools.',
  returns: 'Array of skill objects with name, description, and tools.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: store.list().map(s => ({
      name: s.name,
      description: s.description,
      tools: s.tools,
    })),
  }),
})
