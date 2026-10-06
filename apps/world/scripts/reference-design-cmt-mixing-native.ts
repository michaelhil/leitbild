/** Bounded selected-law qualification through the actual axial residual.
 * No time integrator, production installation or useful-duration claim. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { nativeAxialCandidate } from './reference-design-cmt-native-axial'
import { nativeIf97HeaderSha256, nativeIf97LicenseSha256 } from './reference-design-if97-primitives'

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export async function qualifyNativeMixing(if97Directory: string, ownerPath: string, outputPath: string, allowanceMs = 60_000) {
  if (!Number.isFinite(allowanceMs) || allowanceMs <= 0 || allowanceMs > 60_000)
    throw Error('Invalid remaining mixing qualification allowance')
  const began = performance.now()
  const input = resolve(if97Directory), owner = resolve(ownerPath), output = resolve(outputPath)
  try { await readFile(output); throw Error('Receipt exists; refusing overwrite') }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const ownerBytes = await readFile(owner), headerPath = join(input, 'IF97.h'), licensePath = join(input, 'LICENSE')
  const header = await readFile(headerPath), license = await readFile(licensePath)
  if (sha(header) !== nativeIf97HeaderSha256 || sha(license) !== nativeIf97LicenseSha256)
    throw Error('Pinned IF97 source identity mismatch')
  const candidate = nativeAxialCandidate(ownerBytes.toString())
  const nativeRoot = resolve(import.meta.dir, '../native/process-plant')
  const rustSource = join(nativeRoot, 'src/mixing.rs')
  const sourceFiles = [import.meta.path, rustSource,
    resolve(import.meta.dir, 'reference-design-cmt-native-axial.ts'),
    resolve(import.meta.dir, 'reference-design-cmt-mixing-fixture.ts'),
    resolve(import.meta.dir, 'reference-design-if97-primitives.ts'),
    resolve(import.meta.dir, 'reference-design-cmt-geometry.ts'),
    resolve(import.meta.dir, 'reference-design-cmt-balance-path.ts')]
  const sources = await Promise.all(sourceFiles.map(path => readFile(path)))
  const scratch = await mkdtemp(join(tmpdir(), 'ld01-native-mixing-'))
  const cpp = join(scratch, 'admission.cpp'), library = join(scratch, 'libmixing.a'), binary = join(scratch, 'admission')
  const artifacts = output + '.artifacts'
  await mkdir(artifacts)
  await writeFile(cpp, candidate.cpp, { flag: 'wx' })
  await writeFile(join(artifacts, 'admission.cpp'), candidate.cpp, { flag: 'wx' })
  await Promise.all(sourceFiles.map((path, i) => writeFile(join(artifacts, basename(path)), sources[i]!, { flag: 'wx' })))
  async function execute(command: string[]) {
    const remaining = allowanceMs - (performance.now() - began)
    if (remaining <= 0) return { command, exitCode: null, timedOut: true, stdout: '', stderr: 'Aggregate allowance exhausted' }
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, remaining)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]).finally(() => clearTimeout(timer))
    return { command, exitCode, timedOut, stdout, stderr }
  }
  const success = (result: { exitCode: number | null; timedOut: boolean } | undefined) =>
    result?.exitCode === 0 && !result.timedOut
  const rustVersion = await execute(['rustc', '--version']), cppVersion = await execute(['clang++', '--version'])
  const rustBuild = success(rustVersion) && success(cppVersion)
    ? await execute(['rustc', '--edition=2024', '--crate-type=staticlib', '-C', 'opt-level=2', '-C', 'panic=abort', rustSource, '-o', library])
    : undefined
  const compile = success(rustBuild)
    ? await execute(['clang++', '-std=c++17', '-O2', '-I', input, cpp, library, '-o', binary]) : undefined
  const run = success(compile)
    ? await execute([binary, String(Math.max(0, (allowanceMs - (performance.now() - began)) / 1000)), '--mixing-qualification'])
    : undefined
  let nativeResult: unknown, parseError: string | undefined
  if (run) {
    try { nativeResult = JSON.parse(run.stdout) }
    catch (error) { parseError = error instanceof Error ? error.message : String(error) }
  }
  const nativePassed = !!nativeResult && typeof nativeResult === 'object'
    && 'passed' in nativeResult && nativeResult.passed === true
  const builtArtifacts: { path: string; sha256: string }[] = []
  for (const path of [...(success(rustBuild) ? [library] : []), ...(success(compile) ? [binary] : [])]) {
    const bytes = await readFile(path), retained = join(artifacts, basename(path))
    await writeFile(retained, bytes, { flag: 'wx' })
    builtArtifacts.push({ path: retained, sha256: sha(bytes) })
  }
  const unchanged = (await Promise.all(sourceFiles.map(path => readFile(path))))
    .every((bytes, i) => sha(bytes) === sha(sources[i]!))
    && sha(await readFile(owner)) === sha(ownerBytes)
    && sha(await readFile(headerPath)) === sha(header) && sha(await readFile(licensePath)) === sha(license)
  const elapsedSeconds = (performance.now() - began) / 1000
  const receipt = {
    schema: 'ld01-native-mixing-residual-qualification', recordedAt: new Date().toISOString(),
    passed: success(rustVersion) && success(cppVersion) && success(rustBuild) && success(compile)
      && success(run) && nativePassed && unchanged && elapsedSeconds <= allowanceMs / 1000,
    allowanceSeconds: allowanceMs / 1000, elapsedSeconds, owner: { path: owner, sha256: sha(ownerBytes) },
    geometry: candidate.geometry, upstream: { headerSha256: sha(header), licenseSha256: sha(license) },
    sources: sourceFiles.map((path, i) => ({ path, sha256: sha(sources[i]!) })),
    cppSHA256: sha(candidate.cpp), scratch, artifacts, builtArtifacts, unchanged,
    rustVersion, cppVersion, rustBuild, compile, run, nativeResult, parseError,
    scope: 'Selected low-Re mixing/stress/buoyancy and molecular variance decay, branch-local/physical-right partials and the actual conservative axial residual at finite snapshots only. No time integration, coupled implicit history admission, complete Jacobian, source calibration, plant installation or throughput qualification.',
  }
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  return receipt
}
if (import.meta.main) {
  const [input, owner, output, ...extra] = Bun.argv.slice(2)
  if (!input || !owner || !output || extra.length) throw Error('Expected pinned IF97 directory, current CMT geometry owner and NEW receipt path')
  const receipt = await qualifyNativeMixing(input, owner, output)
  console.log(JSON.stringify({ passed: receipt.passed, elapsedSeconds: receipt.elapsedSeconds,
    nativeResult: receipt.nativeResult, parseError: receipt.parseError, output }))
  if (!receipt.passed) process.exitCode = 1
}
