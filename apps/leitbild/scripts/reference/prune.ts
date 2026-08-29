#!/usr/bin/env bun

import { join } from 'node:path'
import { microworldPacks } from '../../src/app-assembly.ts'
import { currentBuildId, listBuildIds, removeStaleBuilds } from '../../src/reference-data/pipeline.ts'
import { collectRegisteredDatasets } from '../../src/reference-data/registry.ts'
import { referenceRoot } from './config.ts'

interface PruneOptions {
  readonly dataset: string | null
  readonly retain: number
  readonly yes: boolean
}

export const parsePruneArgs = (args: ReadonlyArray<string>): PruneOptions => {
  let dataset: string | null = null
  let retain = 3
  let yes = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--dataset') {
      dataset = args[index + 1] ?? null
      if (!dataset) throw new Error('--dataset requires an id')
      index += 1
    } else if (arg === '--retain') {
      const raw = args[index + 1]
      retain = Number(raw)
      if (!raw || !Number.isInteger(retain) || retain < 1) {
        throw new Error('--retain requires a positive integer')
      }
      index += 1
    } else if (arg === '--yes') yes = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return { dataset, retain, yes }
}

const main = async (): Promise<void> => {
  const options = parsePruneArgs(process.argv.slice(2))
  const root = referenceRoot()
  const datasets = collectRegisteredDatasets(microworldPacks).filter(
    descriptor => options.dataset === null || String(descriptor.id) === options.dataset,
  )
  if (datasets.length === 0) throw new Error(options.dataset ? `Unknown dataset: ${options.dataset}` : 'No datasets registered')

  let candidateCount = 0
  const candidates = new Map<string, ReadonlyArray<string>>()
  for (const descriptor of datasets) {
    const id = String(descriptor.id)
    const all = (await listBuildIds(root, descriptor.id)).map(String)
    const current = await currentBuildId(root, descriptor.id)
    const keep = new Set(all.slice(-options.retain))
    if (current) keep.add(String(current))
    const stale = all.filter(build => !keep.has(build))
    candidates.set(id, stale)
    candidateCount += stale.length
    console.log(`${id}: ${all.length} build(s), current=${current ?? '<none>'}, prune=${stale.length}`)
    for (const build of stale) console.log(`  ${join(root, 'builds', id, build)}`)
  }

  if (candidateCount === 0) {
    console.log('Nothing to prune.')
    return
  }
  if (!options.yes) {
    console.log(`Dry run: ${candidateCount} build(s) would be removed. Re-run with --yes after review.`)
    return
  }

  for (const descriptor of datasets) {
    const removed = await removeStaleBuilds(root, descriptor.id, options.retain)
    if (removed.length !== (candidates.get(String(descriptor.id))?.length ?? 0)) {
      throw new Error(`Build set changed while pruning ${String(descriptor.id)}; review the remaining builds`)
    }
    console.log(`Removed ${removed.length} stale build(s) for ${String(descriptor.id)}.`)
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
