import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative } from 'node:path'
import { z } from 'zod'
import { plantGraphSpecSchema, type PlantGraphSpec } from '../graph/index.ts'
import { ld01TagMapSchema, type Ld01TagMap } from './tag-map.ts'
import { processPlantIcConfigSchema, type ProcessPlantProtectionConfig } from '../runtime/ic/control-protection-model.ts'

// The LD-01 native artifact (shell design §2): a directory named by LD01_UNIT_ARTIFACT holding the `ld01-unit`
// binary, the packets and S3 settled state its LOAD names, the wiki pages it reads, the compiled Plant graph with
// its tag map, the shared libraries the binary loads (macOS: its SUNDIALS and KLU dylibs, their load paths rewritten
// to @executable_path/../lib), `artifact.json` saying which file is which, and `MANIFEST.sha256` (sha256sum format:
// `<hex>  <path>`) over every one of them. Absent, unreadable or mismatched, it is refused with the reason; nothing stands in for it.
// Production sets no LD01_UNIT_ARTIFACT, so an LD-01 Plant is refused there.

export const ld01UnitArtifactEnv = 'LD01_UNIT_ARTIFACT'
export const ld01UnitArtifactDescriptor = 'artifact.json'
export const ld01UnitArtifactManifest = 'MANIFEST.sha256'

const relativePathSchema = z.string().min(1).refine(path => !isAbsolute(path) && !normalize(path).startsWith('..'), 'a path inside the artifact')

const descriptorSchema = z.object({
  format: z.literal('ld01-unit-artifact'),
  binary: relativePathSchema,
  /** Every non-system shared library the binary loads, inside the artifact; each must be in the manifest. */
  libraries: z.array(relativePathSchema),
  load: z.object({
    inputs: z.object({
      packet: relativePathSchema,
      wiki_root: relativePathSchema,
      wiki_commit: z.string().min(1).nullable(),
      // A repository outside the artifact is outside its manifest: the artifact pins its wiki pages by digest instead.
      wiki_repository: z.null(),
      ic: relativePathSchema,
      pzr_control: relativePathSchema,
      pzr_control_wiki: relativePathSchema,
      elec: relativePathSchema,
    }).strict(),
    state: relativePathSchema,
    solver: z.object({ weights: z.string().min(1), first_step: z.string().min(1), stepping: z.string().min(1), water: z.enum(['if97', 'sbtl']) }).strict(),
  }).strict(),
  graph: relativePathSchema,
}).strict()

export const ld01PlantGraphFileSchema = z.object({
  format: z.literal('ld01-plant-graph'),
  /** The packets the graph was compiled from, by SHA-256. */
  sources: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/u)),
  /** What the graph does not model, stated plainly (the turbine's condensate return, a missing feed train). */
  scope: z.array(z.string().min(1)),
  graph: z.unknown(),
  tagMap: ld01TagMapSchema,
  /** The kernel protection's latches as declared alarm and trip rules (scripts/reference-design-operating-graph.ts). */
  automation: z.unknown(),
}).strict()

/** The LOAD request the artifact makes: its inputs as absolute paths, every key the child requires. */
export interface Ld01UnitLoadRequest {
  readonly inputs: {
    readonly packet: string
    readonly wiki_root: string
    readonly wiki_commit: string | null
    readonly wiki_repository: null
    readonly ic: string
    readonly pzr_control: string
    readonly pzr_control_wiki: string
    readonly elec: string
  }
  readonly state: string
  readonly solver: { readonly weights: string; readonly first_step: string; readonly stepping: string; readonly water: 'if97' | 'sbtl' }
}

export interface Ld01UnitArtifact {
  readonly directory: string
  /** SHA-256 of MANIFEST.sha256: the artifact's identity. */
  readonly manifestSha256: string
  readonly binary: string
  readonly load: Ld01UnitLoadRequest
  readonly graph: PlantGraphSpec
  readonly tagMap: Ld01TagMap
  readonly automation: ProcessPlantProtectionConfig
}

export type Ld01UnitArtifactResolution =
  | { readonly ok: true; readonly artifact: Ld01UnitArtifact }
  | { readonly ok: false; readonly reason: string }

const sha256 = (bytes: Uint8Array | string): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

const parseManifest = (text: string): ReadonlyMap<string, string> => {
  const entries = new Map<string, string>()
  for (const [index, line] of text.split('\n').entries()) {
    if (line.length === 0) continue
    const match = /^([a-f0-9]{64}) {2}(\S.*)$/u.exec(line)
    if (match === null) throw new Error(`${ld01UnitArtifactManifest} line ${index + 1} is not "<sha256>  <path>"`)
    const path = relativePathSchema.safeParse(match[2])
    if (!path.success) throw new Error(`${ld01UnitArtifactManifest} line ${index + 1} names ${match[2]}, not a path inside the artifact`)
    if (entries.has(path.data)) throw new Error(`${ld01UnitArtifactManifest} lists ${path.data} twice`)
    entries.set(path.data, match[1]!)
  }
  return entries
}

const verified = new Map<string, { readonly key: string; readonly artifact: Ld01UnitArtifact }>()

/** Reads and verifies the artifact in `directory`; throws with the first reason it is not usable. */
export const loadLd01UnitArtifact = (directory: string): Ld01UnitArtifact => {
  if (!isAbsolute(directory)) throw new Error(`${ld01UnitArtifactEnv} must be an absolute directory, not ${directory}`)
  const manifestText = readFileSync(join(directory, ld01UnitArtifactManifest), 'utf8')
  const manifest = parseManifest(manifestText)
  const stamps = [...manifest.keys()].map(path => {
    const stat = statSync(join(directory, path))
    return `${path}:${stat.size}:${stat.mtimeMs}`
  })
  const key = `${sha256(manifestText)}\u0000${stamps.join('\u0000')}`
  const cached = verified.get(directory)
  if (cached?.key === key) return cached.artifact
  for (const [path, expected] of manifest) {
    const actual = sha256(readFileSync(join(directory, path)))
    if (actual !== expected) throw new Error(`${path} has SHA-256 ${actual}, the manifest says ${expected}`)
  }
  const listed = (path: string, what: string): string => {
    if (!manifest.has(normalize(path))) throw new Error(`${what} ${path} is not in ${ld01UnitArtifactManifest}`)
    return join(directory, path)
  }
  const listedDirectory = (path: string, what: string): string => {
    const inside = [...manifest.keys()].some(entry => !relative(normalize(path), entry).startsWith('..'))
    if (!inside) throw new Error(`${what} ${path} holds no file of ${ld01UnitArtifactManifest}`)
    return join(directory, path)
  }
  const descriptorPath = listed(ld01UnitArtifactDescriptor, 'the descriptor')
  const descriptor = descriptorSchema.parse(JSON.parse(readFileSync(descriptorPath, 'utf8')))
  const binary = listed(descriptor.binary, 'the binary')
  accessSync(binary, constants.X_OK)
  for (const library of descriptor.libraries) listed(library, 'the library')
  const inputs = descriptor.load.inputs
  const load: Ld01UnitLoadRequest = {
    inputs: {
      packet: listed(inputs.packet, 'the joined packet'),
      wiki_root: listedDirectory(inputs.wiki_root, 'the wiki root'),
      wiki_commit: inputs.wiki_commit,
      wiki_repository: null,
      ic: listed(inputs.ic, 'the IC section'),
      pzr_control: listed(inputs.pzr_control, 'the PZR control section'),
      pzr_control_wiki: listedDirectory(inputs.pzr_control_wiki, 'the PZR control wiki root'),
      elec: listed(inputs.elec, 'the electrical packet'),
    },
    state: listed(descriptor.load.state, 'the S3 settled state'),
    solver: descriptor.load.solver,
  }
  const graphFile = ld01PlantGraphFileSchema.parse(JSON.parse(readFileSync(listed(descriptor.graph, 'the Plant graph'), 'utf8')))
  const artifact: Ld01UnitArtifact = {
    directory,
    manifestSha256: sha256(manifestText),
    binary,
    load,
    graph: plantGraphSpecSchema.parse(graphFile.graph),
    tagMap: graphFile.tagMap,
    automation: processPlantIcConfigSchema.parse(graphFile.automation),
  }
  verified.set(directory, { key, artifact })
  return artifact
}

/** The artifact LD01_UNIT_ARTIFACT names, or why there is none to run an LD-01 Plant on. */
export const resolveLd01UnitArtifact = (env: Readonly<Record<string, string | undefined>> = process.env): Ld01UnitArtifactResolution => {
  const directory = env[ld01UnitArtifactEnv]
  if (directory === undefined || directory.length === 0) {
    return { ok: false, reason: `the LD-01 native engine is not installed here: ${ld01UnitArtifactEnv} names no artifact directory` }
  }
  try {
    return { ok: true, artifact: loadLd01UnitArtifact(directory) }
  } catch (error) {
    return { ok: false, reason: `the LD-01 native artifact ${directory} is not usable: ${error instanceof Error ? error.message : String(error)}` }
  }
}
