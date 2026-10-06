/** ONE bounded normal/tighter native pair. No build, retry, deployment or
 * microscopic ladder; caller supplies the frozen native binary/dependencies. */
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compileOperatingNetwork } from './reference-design-operating-network'

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
const nativeDirectory = resolve(import.meta.dir, '../native/process-plant')
async function nativeIdentities() {
  const files = ['Cargo.toml', 'Cargo.lock', 'build.rs']
  for await (const name of new Bun.Glob('{src,examples}/**/*.{rs,cpp}').scan({ cwd: nativeDirectory })) files.push(name)
  return Promise.all([...new Set(files)].sort().map(async name => ({ name,
    sha256: sha(await readFile(join(nativeDirectory, name))) })))
}
export async function qualifyOperatingNetwork(wiki: string, binary: string, receipt: string,
  horizon_s: number, allowance_s: number, artifactFiles: string[], audit = false) {
  if (!artifactFiles.length || artifactFiles.some(p => !p.trim())) throw Error('Explicit frozen native dependency artifacts required')
  const output = resolve(receipt), executable = resolve(binary)
  if (await Bun.file(output).exists()) throw Error('Refusing to overwrite existing evidence')
  // Build/toolchain preparation is separate. Everything from owner consumption
  // through BOTH trajectories shares this one actual wall allowance.
  const began = performance.now()
  const runnerSha256 = sha(await readFile(import.meta.path))
  const input = await compileOperatingNetwork(wiki, { horizon_s, remainingBudget_s: allowance_s })
  const sources = await nativeIdentities(), binarySha256 = sha(await readFile(executable)),
    artifacts = await Promise.all(artifactFiles.map(async path => ({ path: resolve(path), sha256: sha(await readFile(resolve(path))) })))
  // Catch accidental reuse of an older local build before spending a trajectory.
  // This freshness guard supplements, not replaces, actual build provenance.
  const binaryTime = (await stat(executable)).mtimeMs
  const compiledInputs = sources.filter(s => !s.name.startsWith('examples/')
    || s.name === 'examples/operating-network-ida.rs'
    || s.name.startsWith('examples/ida_support/') || s.name.startsWith('examples/operating_network_audit/')
    || s.name.startsWith('examples/operating_network_input/'))
  for (const source of compiledInputs) {
    if ((await stat(join(nativeDirectory, source.name))).mtimeMs > binaryTime)
      throw Error('Native build predates a compiled source; rebuild before execution: ' + source.name)
  }
  const remaining = allowance_s - (performance.now() - began) / 1000
  if (remaining <= 0) throw Error('Aggregate allowance exhausted during preparation; no trajectory executed')
  // Only the remaining allowance changes. The exact input fed to native is
  // hashed; original owners, geometry, coefficients and criteria are frozen.
  const lines = input.nativeInput.split('\n'), header = lines[0]!.split(' ')
  header[5] = String(remaining); lines[0] = header.join(' ')
  const nativeInput = lines.join('\n'), nativeInputSha256 = sha(nativeInput)
  let timedOut = false
  const command = [executable, ...(audit ? ['--audit'] : [])]
  const child = Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => { timedOut = true; child.kill() }, remaining * 1000)
  child.stdin.write(nativeInput); child.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    .finally(() => clearTimeout(timer))
  const diagnosticRecords = audit ? stdout.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(record => record?.scope === 'bounded-operating-matrix-audit' && record?.state && record?.factorization) : []
  let result: Record<string, unknown> | null = null
  try { result = JSON.parse(stdout) } catch { /* Failure receipt retains the exact native output. */ }
  const ownerAfter = await Promise.all(input.ownerIdentities.map(async o => ({ name: o.name,
    sha256: sha(await readFile(join(resolve(wiki), o.name))) })))
  const sourcesAfter = await nativeIdentities()
  const helpersAfter = await Promise.all(input.helperIdentities.map(async h => ({ path: h.path, sha256: sha(await readFile(h.path)) })))
  const artifactsAfter = await Promise.all(artifacts.map(async a => ({ path: a.path, sha256: sha(await readFile(a.path)) })))
  const unchanged = JSON.stringify(ownerAfter) === JSON.stringify(input.ownerIdentities)
    && JSON.stringify(sourcesAfter) === JSON.stringify(sources)
    && JSON.stringify(helpersAfter) === JSON.stringify(input.helperIdentities)
    && JSON.stringify(artifactsAfter) === JSON.stringify(artifacts)
    && sha(await readFile(executable)) === binarySha256
    && sha(await readFile(import.meta.path)) === runnerSha256
  const elapsedSeconds = (performance.now() - began) / 1000
  const accepted = !audit && !timedOut && exitCode === 0 && unchanged && elapsedSeconds <= allowance_s
    && result?.admittedDuration_s === horizon_s
  const evidence = { recordedAt: new Date().toISOString(), allowanceSeconds: allowance_s, elapsedSeconds,
    accepted, executed: true, diagnosticOnly: audit, diagnosticRecords, timedOut, exitCode, unchanged, command, binarySha256,
    artifacts, nativeSources: sources, runnerSha256,
    input: { ...input, nativeInput, nativeInputSha256, controls: { horizon_s, remainingBudget_s: remaining } },
    criteria: { pairedTemperature_K: .01, pairedPressure_Pa: 5000, pairedFiniteHeatRelative: .005,
      finiteHeatVersusNumericalDifference: 100, stockLedgerMass_kg: 1e-6, stockLedgerEnergy_J: 1,
      stockLedgerMarker_kg: 1e-8, chartCorrectionPressure_Pa: 5, chartCorrectionTemperature_K: 1e-4,
      omittedKEquivalent_K: .001, omittedDynamicHead_Pa: 100,
      pressureSplitDensityFraction: 1e-4, pressureSplitWorkEquivalent_K: .01,
      pairedSecondaryPhaseMass_kg: .01,
      secondaryResponseVersusNumericalDifference: 100,
      secondaryResponseMinimum_J: 1,
      secondaryApplicability: 'Closed liquid-bearing water/steam/air/N2, positive gas volume, full folded-wall coverage; bulk and wall below total-pressure saturation; no phase-exhaustion or dryout continuation',
      pairedHeatMeaning: 'Sum of absolute finite-metal and secondary-recipient discrepancies; opposing changes cannot cancel',
      momentumHeldHeadProxy: 'diagnostic only; not a coupled correction bound or admission gate',
      meaning: 'Frozen sound-filtered quasi-steady cold primary-metal-wet-secondary redistribution screen; no inertia/quantitative-flow/entropy/full-plant qualification' },
    result, stdout, stderr, scope: 'One normal/tighter cold connected primary/finite SG metal and wet-secondary partial. The approved shutdown pilot remains unfinished.' }
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
  return evidence
}
if (import.meta.main) {
  const [wiki, binary, receipt, horizon, allowance, ...rest] = Bun.argv.slice(2)
  const audit = rest.includes('--audit'), artifacts = rest.filter(p => p !== '--audit')
  if (rest.filter(p => p === '--audit').length > 1) throw Error('Duplicate audit flag')
  if (!wiki || !binary || !receipt || !horizon || !allowance || !artifacts.length)
    throw Error('Usage: bun reference-design-operating-network-candidate.ts <explicit-LD01-owner-dir> <frozen-native-binary> <NEW-receipt.json> <60..300-seconds> <aggregate-allowance<=120-seconds> <native-dependency-artifacts...>')
  const p = await qualifyOperatingNetwork(wiki, binary, receipt, Number(horizon), Number(allowance), artifacts, audit)
  console.log(JSON.stringify({ accepted: p.accepted, executed: p.executed, elapsedSeconds: p.elapsedSeconds,
    exitCode: p.exitCode, unchanged: p.unchanged, receipt: resolve(receipt), result: p.result, stderr: p.stderr }))
  if (!p.accepted) process.exitCode = 1
}
