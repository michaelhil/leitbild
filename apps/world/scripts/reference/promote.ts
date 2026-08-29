#!/usr/bin/env bun
import { worldPacks } from '../../src/app-assembly.ts'
import { currentBuildId, listBuildIds, promoteBuild } from '../../src/reference-data/pipeline.ts'
import { collectRegisteredDatasets } from '../../src/reference-data/registry.ts'
import { asBuildId } from '../../src/reference-data/types.ts'
import { exitFailure, parseFlags, referenceRoot } from './config.ts'

const flags = parseFlags(process.argv.slice(2))
const root = referenceRoot()

const datasets = collectRegisteredDatasets(worldPacks).filter(
  d => flags.dataset === null || String(d.id) === flags.dataset,
)
if (datasets.length === 0) {
  exitFailure(flags.dataset === null
    ? 'No datasets registered.'
    : `Unknown dataset: ${flags.dataset}`)
}

interface PerDatasetResult {
  readonly id: string
  readonly status: 'ok' | 'failed'
  readonly previous: string | null
  readonly current: string | null
  readonly error?: string
}

const results: PerDatasetResult[] = []

for (const descriptor of datasets) {
  const id = descriptor.id
  try {
    const previous = await currentBuildId(root, id)
    let targetBuildId = flags.buildId
    if (!targetBuildId) {
      const builds = await listBuildIds(root, id)
      const latest = builds[builds.length - 1]
      if (!latest) {
        throw new Error(`No builds found under ${root}/builds/${String(id)}/`)
      }
      targetBuildId = String(latest)
    }
    await promoteBuild(root, id, asBuildId(targetBuildId))
    const current = await currentBuildId(root, id)
    results.push({
      id: String(id),
      status: 'ok',
      previous: previous ? String(previous) : null,
      current: current ? String(current) : null,
    })
  } catch (err) {
    results.push({
      id: String(id),
      status: 'failed',
      previous: null,
      current: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

if (flags.json) {
  console.log(JSON.stringify(results, null, 2))
} else {
  for (const r of results) {
    if (r.status === 'ok') {
      console.log(`✓ ${r.id} → ${r.previous ?? '<none>'} ⇒ ${r.current}`)
    } else {
      console.error(`✗ ${r.id} → ${r.error}`)
    }
  }
}

const anyFailed = results.some(r => r.status === 'failed')
process.exit(anyFailed ? 1 : 0)
