import type { Tool } from '../../core/types/tool.ts'
import type { PackManager } from '../../packs/manager.ts'

/** Agent-facing adapters over the deployment Pack Manager. */
export const createPackTools = (manager: PackManager): ReadonlyArray<Tool> => [
  {
    name: 'install_pack',
    description: 'Installs an Agent Pack from the registry, a user/repo shorthand, or a git URL.',
    usage: 'Bring reviewed domain-specific tools, skills, scripts, or data into the deployment.',
    returns: 'The Pack id, registered contributions, and validated manifest.',
    parameters: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Registry name, user/repo shorthand, or full git URL' } },
      required: ['source'],
    },
    execute: params => manager.install(typeof params.source === 'string' ? params.source : ''),
  },
  {
    name: 'update_pack',
    description: 'Updates an installed Agent Pack and reloads its contributions.',
    returns: 'The Pack id and refreshed contribution inventory.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Pack id' } },
      required: ['id'],
    },
    execute: params => manager.update(typeof params.id === 'string' ? params.id : ''),
  },
  {
    name: 'uninstall_pack',
    description: 'Uninstalls an Agent Pack and removes it from every Room Pack Set.',
    returns: 'The Pack id, removed contributions, and scrubbed Rooms.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Pack id' } },
      required: ['id'],
    },
    execute: params => manager.uninstall(typeof params.id === 'string' ? params.id : ''),
  },
  {
    name: 'list_packs',
    description: 'Lists installed and bundled Agent Packs with their discovered contributions.',
    returns: 'Agent Pack descriptors and tool, skill, wiki, and UI contributions.',
    parameters: { type: 'object', properties: {} },
    execute: () => manager.list(),
  },
  {
    name: 'list_available_packs',
    description: 'Lists Agent Packs available from configured registries and whether each is installed.',
    returns: 'Registry entries with canonical names, sources, descriptions, and installation state.',
    parameters: { type: 'object', properties: {} },
    execute: () => manager.listAvailable(),
  },
]
