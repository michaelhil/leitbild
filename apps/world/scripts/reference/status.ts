#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { worldPacks } from '../../src/app-assembly.ts'
import { currentBuildId, listBuildIds } from '../../src/reference-data/pipeline.ts'
import { collectRegisteredDatasets } from '../../src/reference-data/registry.ts'
import { parseFlags, referenceRoot } from './config.ts'

const flags = parseFlags(process.argv.slice(2))
const root = referenceRoot()

interface DatasetStatus {
  readonly id: string
  readonly currentBuild: string | null
  readonly builds: ReadonlyArray<string>
  readonly airac?: string
  readonly builtAt?: string
  readonly featureCount?: number
}

const datasets = collectRegisteredDatasets(worldPacks).filter(
  d => flags.dataset === null || String(d.id) === flags.dataset,
)

const collect = async (): Promise<ReadonlyArray<DatasetStatus>> => {
  const out: DatasetStatus[] = []
  for (const descriptor of datasets) {
    const id = String(descriptor.id)
    const current = await currentBuildId(root, descriptor.id)
    const builds = (await listBuildIds(root, descriptor.id)).map(String)
    const baseEntry: DatasetStatus = {
      id,
      currentBuild: current ? String(current) : null,
      builds,
    }
    if (!current) {
      out.push(baseEntry)
      continue
    }
    try {
      const manifestPath = join(root, 'releases', id, 'current', `${id}.manifest.json`)
      const raw = await readFile(manifestPath, 'utf8')
      const parsed = JSON.parse(raw) as { airac?: string; builtAt?: string; categories?: Array<{ featureCount?: number }> }
      const featureCount = parsed.categories?.reduce((s, c) => s + (c.featureCount ?? 0), 0)
      out.push({
        ...baseEntry,
        ...(parsed.airac ? { airac: parsed.airac } : {}),
        ...(parsed.builtAt ? { builtAt: parsed.builtAt } : {}),
        ...(typeof featureCount === 'number' ? { featureCount } : {}),
      })
    } catch {
      out.push(baseEntry)
    }
  }
  return out
}

const statuses = await collect()

if (flags.json) {
  console.log(JSON.stringify({ referenceRoot: root, datasets: statuses }, null, 2))
} else {
  console.log(`reference root: ${root}`)
  for (const s of statuses) {
    console.log('')
    console.log(`  ${s.id}`)
    console.log(`    current build : ${s.currentBuild ?? '<none>'}`)
    if (s.airac) console.log(`    airac         : ${s.airac}`)
    if (s.builtAt) console.log(`    built at      : ${s.builtAt}`)
    if (typeof s.featureCount === 'number') console.log(`    features      : ${s.featureCount}`)
    console.log(`    builds on disk: ${s.builds.length}`)
  }
}
