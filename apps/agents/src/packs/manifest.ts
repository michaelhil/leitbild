import { packDescriptorSchema } from '@leitbild/contracts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentPackDescriptor, PackManifest } from './types.ts'

const MANIFEST_FILENAME = 'pack.json'
export const AGENT_PACK_SCHEMA_VERSION = '1.0.0'
export const AGENT_PACK_PLATFORM_VERSION_RANGE = '^1.0.0'

const httpUrlSchema = z.url().refine(value => {
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}, 'must use http or https')

const relativePathSchema = z.string().min(1).refine(
  value => !value.startsWith('/') && !value.split('/').includes('..'),
  'must be a relative path without parent traversal',
)

const wikiSourceBindingSchema = z.object({
  org: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  procedureDir: relativePathSchema,
  indexFile: relativePathSchema,
  citationBase: httpUrlSchema,
  manifestFile: relativePathSchema.optional(),
}).strict()

const wikiRefSchema = z.object({
  name: z.string().min(1).max(256),
  url: httpUrlSchema,
  source: wikiSourceBindingSchema.optional(),
}).strict()

const extensionIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)

const contributionKinds = new Set([
  'tool',
  'skill',
  'script',
  'geodata',
  'wiki',
  'ui-extension',
])

export const agentPackManifestSchema = z.object({
  descriptor: packDescriptorSchema,
  wikis: z.array(wikiRefSchema).default([]),
  uiExtensions: z.array(extensionIdSchema).default([]),
}).strict().superRefine((manifest, ctx) => {
  const descriptor = manifest.descriptor
  if (descriptor.schemaVersion !== AGENT_PACK_SCHEMA_VERSION) {
    ctx.addIssue({
      code: 'custom',
      path: ['descriptor', 'schemaVersion'],
      message: `unsupported Agent Pack schema version ${descriptor.schemaVersion}`,
    })
  }
  if (descriptor.moduleId !== 'agents') {
    ctx.addIssue({
      code: 'custom',
      path: ['descriptor', 'moduleId'],
      message: 'The Agents Module can only load Packs whose moduleId is agents',
    })
  }
  if (!descriptor.description?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['descriptor', 'description'],
      message: 'Agent Packs require a discovery description',
    })
  }
  if (descriptor.platformVersionRange !== AGENT_PACK_PLATFORM_VERSION_RANGE) {
    ctx.addIssue({
      code: 'custom',
      path: ['descriptor', 'platformVersionRange'],
      message: `unsupported platform version range ${descriptor.platformVersionRange}`,
    })
  }

  const declaredKinds = new Set<string>()
  const declaredExtensionIds = new Set<string>()
  descriptor.contributions.forEach((contribution, index) => {
    if (!contributionKinds.has(contribution.kind)) {
      ctx.addIssue({
        code: 'custom',
        path: ['descriptor', 'contributions', index, 'kind'],
        message: `unsupported Agent Pack contribution kind ${contribution.kind}`,
      })
    }
    declaredKinds.add(contribution.kind)
    if (contribution.kind === 'ui-extension') {
      if (!contribution.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['descriptor', 'contributions', index, 'id'],
          message: 'ui-extension contributions require an id',
        })
      } else {
        declaredExtensionIds.add(contribution.id)
      }
    } else if (contribution.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['descriptor', 'contributions', index, 'id'],
        message: `${contribution.kind} contributions must not declare an id`,
      })
    }
  })

  if ((manifest.wikis.length > 0) !== declaredKinds.has('wiki')) {
    ctx.addIssue({
      code: 'custom',
      path: ['wikis'],
      message: 'wikis metadata and the wiki contribution declaration must either both be present or both be absent',
    })
  }
  const extensionIds = new Set(manifest.uiExtensions)
  if (extensionIds.size !== manifest.uiExtensions.length) {
    ctx.addIssue({ code: 'custom', path: ['uiExtensions'], message: 'duplicate UI extension id' })
  }
  if (
    extensionIds.size !== declaredExtensionIds.size
    || [...extensionIds].some(id => !declaredExtensionIds.has(id))
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['uiExtensions'],
      message: 'uiExtensions must exactly match declared ui-extension contribution ids',
    })
  }
})

export interface PackManifestError extends Error {
  readonly name: 'PackManifestError'
  readonly filePath: string
}

const packManifestError = (filePath: string, message: string, cause?: unknown): PackManifestError => {
  const error = new Error(`${filePath}: ${message}`, cause === undefined ? undefined : { cause }) as PackManifestError
  Object.defineProperties(error, {
    name: { value: 'PackManifestError' },
    filePath: { value: filePath, enumerable: true },
  })
  return error
}

export const parsePackManifest = (value: unknown, filePath = MANIFEST_FILENAME): PackManifest => {
  const result = agentPackManifestSchema.safeParse(value)
  if (!result.success) {
    const details = result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw packManifestError(filePath, details)
  }
  return result.data as PackManifest
}

export const readManifest = async (dirPath: string): Promise<PackManifest> => {
  const filePath = join(dirPath, MANIFEST_FILENAME)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (error) {
    throw packManifestError(filePath, 'required Pack manifest is missing or unreadable', error)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw packManifestError(filePath, 'invalid JSON', error)
  }
  return parsePackManifest(parsed, filePath)
}

export const createAgentPackDescriptor = (input: {
  readonly id: string
  readonly version: string
  readonly name: string
  readonly description: string
  readonly contributions: ReadonlyArray<{ readonly kind: string; readonly id?: string }>
  readonly dependencies?: ReadonlyArray<{ readonly id: string; readonly versionRange: string }>
}): AgentPackDescriptor => packDescriptorSchema.parse({
  schemaVersion: AGENT_PACK_SCHEMA_VERSION,
  id: input.id,
  moduleId: 'agents',
  version: input.version,
  name: input.name,
  description: input.description,
  platformVersionRange: AGENT_PACK_PLATFORM_VERSION_RANGE,
  dependencies: [...(input.dependencies ?? [])],
  contributions: [...input.contributions],
}) as AgentPackDescriptor
