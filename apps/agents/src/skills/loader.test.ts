// ============================================================================
// Skill loader — frontmatter parsing and metadata preservation tests.
//
// The parser tests are pure string-in/string-out. The warn test uses a temp
// directory with a real SKILL.md to exercise loadSkills end-to-end.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { parseFrontmatter, loadSkills, createSkillStore } from './loader.ts'
import { createToolRegistry } from '../core/tool-registry.ts'

describe('parseFrontmatter — allowed-tools', () => {
  test('parses inline array form', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
allowed-tools: [web_search, read_file]
---
body`)
    expect(frontmatter.allowedTools).toEqual(['web_search', 'read_file'])
  })

  test('parses YAML block list with 2-space indent', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
allowed-tools:
  - web_search
  - read_file
---
body`)
    expect(frontmatter.allowedTools).toEqual(['web_search', 'read_file'])
  })

  test('parses YAML block list with 0-space indent', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
allowed-tools:
- web_search
- read_file
---
body`)
    expect(frontmatter.allowedTools).toEqual(['web_search', 'read_file'])
  })

  test('missing allowed-tools stays undefined', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
---
body`)
    expect(frontmatter.allowedTools).toBeUndefined()
  })

  test('empty block list becomes empty array', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
allowed-tools:
---
body`)
    expect(frontmatter.allowedTools).toEqual([])
  })

  test('rejects scalar values for array fields', () => {
    expect(() => parseFrontmatter(`---
name: foo
description: test
allowed-tools: web_search
---
body`)).toThrow('array frontmatter fields')
  })

  test('does not consume following key lines as block items', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: test
allowed-tools:
  - a
description-extra: ignored
---
body`)
    expect(frontmatter.allowedTools).toEqual(['a'])
  })

  test('body parses correctly after block-list field', () => {
    const { body } = parseFrontmatter(`---
name: foo
description: test
allowed-tools:
  - a
  - b
---
# Body heading

content`)
    expect(body).toBe('# Body heading\n\ncontent')
  })
})

describe('loadSkills — allowed-tools metadata', () => {
  const makeSkillDir = async (dirRoot: string, name: string, frontmatter: string) => {
    const skillDir = join(dirRoot, name)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), frontmatter)
    return skillDir
  }

  test('Skill.allowedToolNames is populated from frontmatter', async () => {
    const base = await mkdtemp(join(tmpdir(), 'leitbild-skills-test-'))
    try {
      await makeSkillDir(base, 'alpha', `---
name: alpha
description: test
allowed-tools: [a, b]
---
body`)

      const registry = createToolRegistry()
      const store = createSkillStore()
      const result = await loadSkills(base, store, registry)

      expect(result.loaded).toContain('alpha')
      const skill = store.get('alpha')
      expect(skill?.allowedToolNames).toEqual(['a', 'b'])
    } finally {
      await rm(base, { recursive: true })
    }
  })

  test('defers tool-surface validation until the Room runtime is assembled', async () => {
    const base = await mkdtemp(join(tmpdir(), 'leitbild-skills-test-'))
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: unknown) => { warnings.push(String(msg)) }

    try {
      await makeSkillDir(base, 'bravo', `---
name: bravo
description: test
allowed-tools: [workspace_bound_tool]
---
body`)

      const registry = createToolRegistry()
      const store = createSkillStore()
      await loadSkills(base, store, registry)

      expect(store.get('bravo')?.allowedToolNames).toEqual(['workspace_bound_tool'])
      const warnLines = warnings.filter(w => w.includes('bravo') && w.includes('allowed-tools'))
      expect(warnLines).toHaveLength(0)
    } finally {
      console.warn = originalWarn
      await rm(base, { recursive: true })
    }
  })

  test('skill without allowed-tools gets empty array', async () => {
    const base = await mkdtemp(join(tmpdir(), 'leitbild-skills-test-'))

    try {
      await makeSkillDir(base, 'delta', `---
name: delta
description: test
---
body`)

      const registry = createToolRegistry()
      const store = createSkillStore()
      await loadSkills(base, store, registry)

      const skill = store.get('delta')
      expect(skill?.allowedToolNames).toEqual([])
    } finally {
      await rm(base, { recursive: true })
    }
  })
})

describe('parseFrontmatter — fence + quoted values', () => {
  test('throws on opening fence without closing fence', () => {
    expect(() => parseFrontmatter(`---
name: foo
description: missing closing fence

body content here`)).toThrow(/no closing/)
  })

  test('passes through when there is no opening fence (treats whole file as body)', () => {
    const { frontmatter, body } = parseFrontmatter('just markdown body, no frontmatter')
    expect(frontmatter).toEqual({})
    expect(body).toBe('just markdown body, no frontmatter')
  })

  test('strips matching double quotes from value', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: "value with: embedded colon"
---
body`)
    expect(frontmatter.description).toBe('value with: embedded colon')
  })

  test('strips matching single quotes from value', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: 'single-quoted'
---
body`)
    expect(frontmatter.description).toBe('single-quoted')
  })

  test('preserves unquoted value with colon (slice-on-first-colon was already correct)', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: Use when calling https://example.com/api
---
body`)
    expect(frontmatter.description).toBe('Use when calling https://example.com/api')
  })

  test('does not strip mismatched quotes', () => {
    const { frontmatter } = parseFrontmatter(`---
name: foo
description: "starts double, ends single'
---
body`)
    // Mismatched quotes left intact (no spec violation; just don't lie about it).
    expect(frontmatter.description).toBe(`"starts double, ends single'`)
  })
})

describe('loadSkills — malformed fence surfaces in errors', () => {
  test('SKILL.md with opening fence but no closing fence is recorded as an error, not silently skipped', async () => {
    const base = await mkdtemp(join(tmpdir(), 'leitbild-skills-fence-'))
    try {
      await mkdir(join(base, 'broken'))
      await writeFile(
        join(base, 'broken', 'SKILL.md'),
        `---\nname: broken\ndescription: never closes\n\nbody`,
      )
      const store = createSkillStore()
      const reg = createToolRegistry()
      const result = await loadSkills(base, store, reg)
      expect(result.errors.some(e => e.includes('broken') && e.includes('no closing'))).toBe(true)
      expect(store.get('broken')).toBeUndefined()
    } finally {
      await rm(base, { recursive: true })
    }
  })
})
