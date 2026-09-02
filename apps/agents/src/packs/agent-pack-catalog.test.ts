import { describe, expect, test } from 'bun:test'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createSkillStore } from '../skills/loader.ts'
import { createAgentPackDescriptor, parsePackManifest } from './manifest.ts'
import { createAgentPackCatalog } from './agent-pack-catalog.ts'

describe('Agent Pack catalog', () => {
  test('rejects filesystem Packs that shadow bundled Pack ids', () => {
    const catalog = createAgentPackCatalog({
      packsDir: '/unused',
      toolRegistry: createToolRegistry(),
      skillStore: createSkillStore(),
    })
    const manifest = parsePackManifest({
      descriptor: createAgentPackDescriptor({
        id: 'demos',
        version: '1.0.0',
        name: 'Shadow Demos',
        description: 'Invalid shadow Pack used by this test.',
        contributions: [{ kind: 'tool' }],
      }),
      wikis: [],
      uiExtensions: [],
    })

    expect(() => catalog.replaceInstalled([{ id: 'demos', dirPath: '/packs/demos', manifest }]))
      .toThrow('conflicts with a bundled Pack')
  })
})
