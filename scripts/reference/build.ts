#!/usr/bin/env bun
import { buildDataset } from '../../src/reference-data/pipeline.ts'
import { registeredDatasets } from '../../src/reference-data/registry.ts'
import { buildEnv, exitFailure, parseFlags } from './config.ts'

const flags = parseFlags(process.argv.slice(2))
const env = buildEnv()

const datasets = registeredDatasets(process.env).filter(
  d => flags.dataset === null || String(d.id) === flags.dataset,
)

if (datasets.length === 0) {
  if (flags.dataset !== null) exitFailure(`Unknown dataset: ${flags.dataset}`)
  console.warn('No datasets registered.')
  process.exit(0)
}

interface PerDatasetResult {
  readonly id: string
  readonly status: 'ok' | 'failed'
  readonly buildId?: string
  readonly featureCount?: number
  readonly buildDir?: string
  readonly error?: string
}

const results: PerDatasetResult[] = []

for (const descriptor of datasets) {
  try {
    const config = descriptor.build()
    const outcome = await buildDataset(config, env)
    results.push({
      id: String(descriptor.id),
      status: 'ok',
      buildId: String(outcome.buildId),
      featureCount: outcome.featureCount,
      buildDir: outcome.buildDir,
    })
  } catch (err) {
    results.push({
      id: String(descriptor.id),
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

if (flags.json) {
  console.log(JSON.stringify(results, null, 2))
} else {
  for (const r of results) {
    if (r.status === 'ok') {
      console.log(`✓ ${r.id} → buildId=${r.buildId} features=${r.featureCount} dir=${r.buildDir}`)
    } else {
      console.error(`✗ ${r.id} → ${r.error}`)
    }
  }
}

const anyFailed = results.some(r => r.status === 'failed')
process.exit(anyFailed ? 1 : 0)
