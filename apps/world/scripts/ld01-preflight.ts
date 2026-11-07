/** Read-only verification of the retained r4m regression inputs and receipts. */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { canonical, digest, sha256, sha256File } from './ld01-receipts'
import { environmentMismatch, TRAJECTORY_SECTIONS, type Expectation, type SpanPin } from './ld01-tier'
import { sundialsConfiguration } from './reference-design-native-stack'
import { gitTreeHash, wikiProvenance } from './reference-design-wiki-provenance'

const app = '69d513b3a75d9727d7fae21351299112adf6d526'
const wikiCommit = '620186f66a666a914b6ffdfde245d730f31a3d9b'
const tierPinCommit = '2d39d4e790e736de90d568eb389cd0e17585d261'
const smokePinCommit = '71c6af901326b6f3ed4a6a39dd6de41350672b53'
const wikiModel = 'world/packs/process-plant/reference-designs/ld-01/model'
const pinDir = 'apps/world/native/process-plant/operating/water-ffi/tests/ld01_regression'
const tierPin = `${pinDir}/tier1-macos-aarch64.json`

// The accepted T1 pin names this receipt. These hashes seal the retained
// records checked on 7 November, including files the original pin did not hash.
const receiptHashes = {
  'tuple.json': 'ed7d6f1e757cfd727a0c07855d9830d1b5b9da127455ff92fa1ed9bd207b0ff9',
  't1.json': 'b1cb213639dbae98395a29410dcfd6d40bc92637359403e5dfe0d87ac5ff304f',
  'smoke.log': '8089c1a0e366bcc3ae153ebbec4010ffae4e9af4d3ca43d62df2c7b76829b1f7',
  'C2@0.json': '05340482c5ec25733eb62ec868debe9a13911988ee5189de48bb9c2062ec831f',
  'C2@2.5.json': '6590d783cfa62b6b2d0474fba79dcabddb3af80fc046951bf590eef4a7a51d58',
}
const kluHashes = {
  'libamd.3.3.4.dylib': '0f86130f5cb2897f517c49052365b41fd583c83b6af9ecdce59f6973505d0f97',
  'libbtf.2.3.3.dylib': '20d9b391a7b3abed58f8b5d7367fadd192578f1a0e8f6345caa7cd4d0741a8ba',
  'libcolamd.3.3.5.dylib': 'e6a83e29bb7a18e266afe056cd0900ba7fc06c3183110889b1e26369cbdc883b',
  'libklu.2.3.6.dylib': '197457d16242d1b78e306e8968c2746b99a257c5443f25bff544eb8766ebe93b',
  'libsuitesparseconfig.7.12.3.dylib': '3211ff807526aa6e719a3d52bfcac60f409d534276d84e173ba0bbf20314e1bb',
}

function requireEqual(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) throw Error(`${label}: expected ${expected}, got ${actual}`)
}

function requireHash(path: string, expected: string) {
  requireEqual(path, sha256File(path), expected)
}

function appFile(commit: string, path: string) {
  const result = Bun.spawnSync(['git', '-C', resolve(import.meta.dir, '../../..'), 'show', `${commit}:${path}`])
  if (result.exitCode !== 0) throw Error(`Cannot read application pin ${commit}:${path}: ${result.stderr.toString().trim()}`)
  return result.stdout
}

async function preflight(receiptDir: string, wiki: string, wikiRepository: string) {
  for (const [name, hash] of Object.entries(receiptHashes)) requireHash(join(receiptDir, name), hash)
  const pins: Expectation = JSON.parse(appFile(tierPinCommit, tierPin).toString())
  const tuple: {
    app_full: string, dirty: boolean, script_sha256: string, library_sha256: string,
    pin_environment: Record<string, string | null>,
    environment: Record<string, { value: string, kind: string, sha256: string | null }>,
  } = await Bun.file(join(receiptDir, 'tuple.json')).json()
  const result: { verdict: string, pin_file_sha256: string, spans: Record<string, { measured: SpanPin }> } =
    await Bun.file(join(receiptDir, 't1.json')).json()
  requireEqual('app', tuple.app_full, app)
  requireEqual('recorded app', pins.app, app.slice(0, 9))
  requireEqual('recorded tree dirty', tuple.dirty, false)
  requireEqual('T1 verdict', result.verdict, 'PASS')
  requireEqual('prior T1 expectation', sha256(appFile(app, tierPin)), result.pin_file_sha256)
  requireEqual('tier script', sha256(appFile(app, 'apps/world/scripts/ld01-tier.ts')), tuple.script_sha256)
  requireEqual('receipt library', sha256(appFile(app, 'apps/world/scripts/ld01-receipts.ts')), tuple.library_sha256)
  const mismatch = environmentMismatch(pins.environment, tuple.pin_environment)[0]
  if (mismatch) requireEqual(mismatch.key, mismatch.current, mismatch.pinned)
  for (const [span, pin] of Object.entries(pins.spans)) {
    const receipt = await Bun.file(join(receiptDir, `${span}.json`)).json()
    requireEqual(`${span} trajectory`, digest(receipt.run, TRAJECTORY_SECTIONS), pin.digest)
    requireEqual(`${span} instructions`, result.spans[span]?.measured.instructions, pin.instructions)
  }

  const verifiedWiki = await wikiProvenance(wiki, { LD01_WIKI_COMMIT: wikiCommit, LD01_WIKI_REPOSITORY: wikiRepository })
  const originalWiki = tuple.environment.LD01_WIKI_ROOT!.value
  for (const { value, sha256: hash } of Object.values(tuple.environment)) {
    if (hash) requireHash(value.startsWith(`${originalWiki}/`) ? join(wiki, relative(originalWiki, value)) : value, hash)
  }

  const water = tuple.environment.LD01_OPERATING_WATER_LIB_DIR!.value
  const waterReceipt = join(water, 'water-build.json')
  requireHash(waterReceipt, '96b168f9efe1fe4827abf2f202d3858d1009f6dba957e92f086e90f4f17fb834')
  const waterBuild = await Bun.file(waterReceipt).json()
  requireHash(join(water, 'libld01_operating_water.a'), waterBuild.librarySha256)
  requireHash(join(water, 'sbtl-tables.bin'), waterBuild.sbtl.tableSha256)
  const smokePin = JSON.parse(appFile(smokePinCommit, `${pinDir}/smoke-macos-aarch64.json`).toString())
  const smokeRecord = readFileSync(join(receiptDir, 'smoke.log'), 'utf8').match(/test smoke \.\.\. (\{"info"[^\n]+)\n/)?.[1]
  requireEqual('smoke result', smokeRecord && canonical(JSON.parse(smokeRecord).smoke), canonical(smokePin))
  const smoke = smokePin.environment
  const readiness = readFileSync(join(wiki, wikiModel, 'build-readiness.md'), 'utf8')
  const gates = readiness.match(/```ld01-s1-gates\n([\s\S]*?)\n```/)?.[1]
  requireEqual('smoke S1 gates', gates && sha256(gates), smoke.s1_gates_sha256)
  requireEqual('smoke packet', tuple.pin_environment.packet_sha256, smoke.packet_sha256)
  requireEqual('smoke IF97 revision', waterBuild.revision, smoke.if97_revision)
  requireEqual('smoke water adapter', waterBuild.adapterSha256, smoke.water_adapter_sha256)
  requireHash(join(wiki, wikiModel, 'operating-phase-properties.md'), smoke.metastable_page_sha256)

  const solver = tuple.environment.LD01_OPERATING_SUNDIALS_PREFIX!.value
  const headers = join(solver, 'include')
  const configuration = readFileSync(join(headers, 'sundials/sundials_config.h'), 'utf8')
  sundialsConfiguration(configuration)
  requireEqual('smoke SUNDIALS version', configuration.match(/^#define SUNDIALS_VERSION "(.+)"$/m)?.[1], smoke.sundials_version)
  // Preserve the currently retained headers and SuiteSparse bytes. The 1 Nov
  // solver build receipt recorded only SUNDIALS library hashes and KLU paths.
  requireEqual('SUNDIALS headers', await gitTreeHash(headers), '1bde675a0e1afde7e36b13c61ea6c1741d308337')
  requireEqual('SuiteSparse headers', await gitTreeHash(realpathSync(join(headers, 'suitesparse'))), '66d3e047c4384a60da40c21bab4a04f916ec717d')
  const solverReceipt = join(dirname(solver), 'build-receipt.json')
  requireHash(solverReceipt, '1b97cd1d1b98c883b6b0bca49fb53d4c51f9d24e13af6b44a66ecc4968575e3d')
  const solverBuild: { libraries_sha256: Record<string, string>, klu_links: Record<string, string> } =
    await Bun.file(solverReceipt).json()
  for (const [name, hash] of Object.entries(solverBuild.libraries_sha256)) {
    const library = join(solver, 'lib', name)
    requireHash(library, hash)
    requireEqual(`SUNDIALS ${name} link target`, realpathSync(library.replace(/\.\d+\.\d+\.\d+\.dylib$/, '.dylib')), realpathSync(library))
  }
  for (const [name, target] of Object.entries(solverBuild.klu_links)) {
    requireEqual(`SuiteSparse ${name} target`, realpathSync(join(solver, 'lib', name)), realpathSync(target))
  }
  for (const [name, hash] of Object.entries(kluHashes)) requireHash(join(solver, 'lib', name), hash)

  console.log(`LD-01 r4m retained regression verified\napp ${app}\nwiki ${verifiedWiki.commit}\nreceipts ${resolve(receiptDir)}`)
}

if (import.meta.main) {
  const [receiptDir, wiki, wikiRepository, ...extra] = Bun.argv.slice(2)
  try {
    if (!receiptDir || !wiki || !wikiRepository || extra.length) {
      throw Error('usage: bun --no-env-file apps/world/scripts/ld01-preflight.ts <T1 receipt directory> <pinned wiki export> <wiki Git repository>')
    }
    await preflight(receiptDir, wiki, wikiRepository)
  } catch (error) {
    console.error(`ld01-preflight: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
