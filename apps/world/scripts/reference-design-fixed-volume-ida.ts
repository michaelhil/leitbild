/** Offline forward-storage + actual IDA/KLU admission. No live Pack registration.
 * Requires pinned private source archives; does not download or install host packages.
 * Usage: bun this.ts IF97_DIR SUITESPARSE_ARCHIVE SUNDIALS_ARCHIVE CMAKE NEW_RECEIPT [PREVIOUS_RECEIPT]
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeIf97HeaderSha256, nativeIf97LicenseSha256, nativeIf97Source } from './reference-design-if97-primitives';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pins = {
  suitesparse: { version: '7.12.3', sha256: '158ee4ed2ce3fdcbf52c4e47e94b0d1a8ae13344b4a835991d78a3ad20f08086',
    source: 'https://github.com/DrTimothyAldenDavis/SuiteSparse/releases/tag/v7.12.3' },
  sundials: { version: '7.5.0', sha256: '089ac659507def738b7a65b574ffe3a900d38569e3323d9709ebed3e445adecc',
    source: 'https://github.com/LLNL/sundials/releases/tag/v7.5.0' },
};

export async function runFixedVolumeAdmission(if97Directory: string, suiteArchive: string,
  sundialsArchive: string, cmakePath: string, receiptPath: string, previousReceipt?: string) {
  if (!['darwin', 'linux'].includes(process.platform)) throw Error('Native Unix admission only');
  const output = resolve(receiptPath), input = resolve(if97Directory);
  try { await readFile(output); throw Error('Receipt exists; refusing overwrite'); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  for (const [path, expected] of [[suiteArchive, pins.suitesparse.sha256], [sundialsArchive, pins.sundials.sha256],
    [join(input, 'IF97.h'), nativeIf97HeaderSha256], [join(input, 'LICENSE'), nativeIf97LicenseSha256]]) {
    if (sha(await readFile(path!)) !== expected) throw Error(`Source identity mismatch: ${path}`);
  }
  const root = resolve(import.meta.dir, '../native/process-plant');
  async function fingerprint() {
    const files = [...new Bun.Glob('**/*.{rs,cpp,toml,lock}').scanSync({ cwd: root })]
      .filter(file => !file.startsWith('target/')).sort();
    return Promise.all(files.map(async file => ({ file, sha256: sha(await readFile(join(root, file))) })));
  }
  const artifacts = await fingerprint();
  const wrapperSha256 = sha(await readFile(import.meta.path));
  const primitiveSha256 = sha(await readFile(new URL('./reference-design-if97-primitives.ts', import.meta.url)));
  const scratch = await mkdtemp(join(tmpdir(), 'ld01-forward-ida-'));
  const prefix = join(scratch, 'prefix'), cmake = resolve(cmakePath);
  const bridge = `${nativeIf97Source(true)}\n${await readFile(join(root, 'src/if97-bridge.cpp'), 'utf8')}`;
  await writeFile(join(scratch, 'if97-bridge.cpp'), bridge, { flag: 'wx' });
  const libraries = ['sundials_ida', 'sundials_core', 'sundials_nvecserial', 'sundials_sunmatrixsparse', 'sundials_sunlinsolklu'];
  const environment = { ...process.env, LEITBILD_IF97_DIR: input, LEITBILD_IF97_BRIDGE_DIR: scratch,
    CARGO_TARGET_DIR: join(scratch, 'target'),
    RUSTFLAGS: [`-L native=${join(prefix, 'lib')}`, ...libraries.map(name => `-l ${name}`),
      `-C link-arg=-Wl,-rpath,${join(prefix, 'lib')}`].join(' ') };
  const commands: { command: string[]; stage: string; stdout: string; stderr: string;
    exitCode: number | null; timedOut: boolean; seconds: number }[] = [];
  const used = { build: 0, numerical: 0 }, allowance = { build: 600, numerical: 120 };
  // A corrected attempt consumes the SAME campaign allowance; retain its failed predecessor.
  if (previousReceipt) {
    const prior = JSON.parse(await readFile(resolve(previousReceipt), 'utf8'));
    if (prior.schema !== 'ld01-offline-forward-ida-admission' || prior.passed !== false
      || JSON.stringify(prior.upstream) !== JSON.stringify(pins)
      || prior.allowance.build !== allowance.build || prior.allowance.numerical !== allowance.numerical
      || !Number.isFinite(prior.used.build) || !Number.isFinite(prior.used.numerical)
      || prior.used.build < 0 || prior.used.numerical < 0) throw Error('Invalid preceding campaign receipt');
    used.build = prior.used.build; used.numerical = prior.used.numerical;
  }
  async function execute(command: string[], stage: keyof typeof used) {
    const began = performance.now(), remaining = (allowance[stage] - used[stage]) * 1000;
    if (remaining <= 0) throw Error(`${stage} aggregate allowance exhausted`);
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', env: environment, detached: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Stop compiler/build descendants too; the isolated group belongs to this command only.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
    }, remaining);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer));
    const seconds = (performance.now() - began) / 1000;
    used[stage] += seconds;
    const result = { command, stage, stdout, stderr, exitCode, timedOut, seconds };
    commands.push(result);
    if (exitCode !== 0 || timedOut) throw Error(`Failed ${stage}: ${command.join(' ')}\n${stderr.slice(-3000)}`);
    return result;
  }
  const suite = join(scratch, 'SuiteSparse-7.12.3'), sundials = join(scratch, 'sundials-7.5.0');
  let failure: string | undefined, witness: unknown;
  const dependencyArtifacts: { file: string; sha256: string }[] = [];
  try {
    await execute(['tar', '-xzf', resolve(suiteArchive), '-C', scratch, ...['CMakeLists.txt',
      'SuiteSparse_config', 'AMD', 'COLAMD', 'BTF', 'KLU'].map(name => `SuiteSparse-7.12.3/${name}`)], 'build');
    await execute(['tar', '-xzf', resolve(sundialsArchive), '-C', scratch], 'build');
    await execute([cmake, '-S', suite, '-B', join(scratch, 'suite-build'),
      '-DSUITESPARSE_ENABLE_PROJECTS=suitesparse_config;amd;colamd;btf;klu',
      `-DCMAKE_INSTALL_PREFIX=${prefix}`, '-DCMAKE_INSTALL_LIBDIR=lib', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=ON',
      '-DBUILD_STATIC_LIBS=OFF', '-DSUITESPARSE_DEMOS=OFF', '-DSUITESPARSE_USE_CUDA=OFF',
      '-DSUITESPARSE_USE_OPENMP=OFF', '-DSUITESPARSE_REQUIRE_BLAS=OFF', '-DBLA_VENDOR=Generic',
      '-DKLU_USE_CHOLMOD=OFF'], 'build');
    await execute([cmake, '--build', join(scratch, 'suite-build'), '--parallel', '4'], 'build');
    await execute([cmake, '--install', join(scratch, 'suite-build')], 'build');
    await execute([cmake, '-S', sundials, '-B', join(scratch, 'sundials-build'),
      `-DCMAKE_INSTALL_PREFIX=${prefix}`, '-DCMAKE_INSTALL_LIBDIR=lib', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=ON',
      '-DBUILD_STATIC_LIBS=OFF', '-DBUILD_IDA=ON', '-DBUILD_IDAS=OFF', '-DBUILD_ARKODE=OFF',
      '-DBUILD_CVODE=OFF', '-DBUILD_CVODES=OFF', '-DBUILD_KINSOL=OFF', '-DEXAMPLES_ENABLE_C=OFF',
      '-DEXAMPLES_ENABLE_CXX=OFF', '-DENABLE_KLU=ON', '-DSUNDIALS_INDEX_SIZE=64',
      `-DKLU_INCLUDE_DIR=${join(prefix, 'include/suitesparse')}`, `-DKLU_LIBRARY_DIR=${join(prefix, 'lib')}`], 'build');
    await execute([cmake, '--build', join(scratch, 'sundials-build'), '--parallel', '4'], 'build');
    await execute([cmake, '--install', join(scratch, 'sundials-build')], 'build');
    const config = await readFile(join(prefix, 'include/sundials/sundials_config.h'), 'utf8');
    if (!/^#define SUNDIALS_INT64_T 1$/m.test(config) || !/^#define SUNDIALS_DOUBLE_PRECISION 1$/m.test(config)
      || !/^#define SUNDIALS_MPI_ENABLED 0$/m.test(config)
      || !/^#define SUNDIALS_KLU_ENABLED\s*$/m.test(config)) throw Error('Unexpected SUNDIALS ABI/backend configuration');
    const extension = process.platform === 'darwin' ? 'dylib' : 'so';
    for (const file of ['include/sundials/sundials_config.h',
      ...[...libraries, 'klu', 'amd', 'colamd', 'btf', 'suitesparseconfig'].map(name => `lib/lib${name}.${extension}`)]) {
      dependencyArtifacts.push({ file, sha256: sha(await readFile(join(prefix, file))) });
    }
    for (const [base, file] of [[suite, 'KLU/Doc/License.txt'], [suite, 'BTF/Doc/License.txt'],
      [suite, 'AMD/Doc/License.txt'], [suite, 'COLAMD/Doc/License.txt'], [sundials, 'LICENSE']] as const) {
      dependencyArtifacts.push({ file, sha256: sha(await readFile(join(base, file))) });
    }
    await execute(['cargo', 'test', '--release', '--lib', '--tests', '--no-run', '--manifest-path', join(root, 'Cargo.toml')], 'build');
    await execute(['cargo', 'build', '--release', '--features', 'offline-ida', '--example', 'fixed-volume-ida',
      '--manifest-path', join(root, 'Cargo.toml')], 'build');
    await execute(['cargo', 'test', '--release', '--lib', '--tests', '--manifest-path', join(root, 'Cargo.toml')], 'numerical');
    const result = await execute([join(scratch, 'target/release/examples/fixed-volume-ida'),
      '4', '1', '15500000', '300', '100000', '300', String(allowance.numerical - used.numerical)], 'numerical');
    witness = JSON.parse(result.stdout);
    if (!(witness && typeof witness === 'object' && 'passed' in witness && witness.passed === true
      && 'status' in witness && witness.status === 'completed')) throw Error('Native witness did not pass physical component admission');
  } catch (error) { failure = String(error); }
  const artifactsAfter = await fingerprint();
  const sourcesUnchanged = JSON.stringify(artifacts) === JSON.stringify(artifactsAfter)
    && wrapperSha256 === sha(await readFile(import.meta.path))
    && primitiveSha256 === sha(await readFile(new URL('./reference-design-if97-primitives.ts', import.meta.url)));
  if (!sourcesUnchanged) failure = `${failure ? `${failure}; ` : ''}Source changed during qualification`;
  const receipt = { schema: 'ld01-offline-forward-ida-admission', recordedAt: new Date().toISOString(),
    passed: !failure, failure, allowance, used, previousReceipt: previousReceipt && resolve(previousReceipt), scratch, upstream: pins,
    if97: { headerSha256: nativeIf97HeaderSha256, licenseSha256: nativeIf97LicenseSha256 },
    licenses: 'KLU/BTF LGPL-2.1-or-later; AMD/COLAMD/SuiteSparse_config BSD-3-Clause; SUNDIALS BSD-3-Clause; IF97 MIT. Shared native libraries, private offline build only.',
    generatedBridgeSha256: sha(bridge), artifacts, artifactsAfter, sourcesUnchanged, dependencyArtifacts, wrapperSha256, primitiveSha256,
    fixture: { volumeM3: 4, elevationM: 1, pressurePa: 15500000, temperatureK: 300,
      energyReceiptWatts: 100000, horizonSeconds: 300,
      provenance: 'Declared sealed-liquid component qualification witness. Prescribed external heat receipt, zero mass receipt; not plant/CMT forcing or connected-source evidence.' },
    commands, witness,
    scope: 'Actual pinned sparse backend and forward stable-liquid storage advancement only. No flow, moving layers, phase changes, source calibration, whole plant, target-host throughput or construction-readiness qualification.' };
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}
if (import.meta.main) {
  const [input, suite, sundials, cmake, receipt, previous] = process.argv.slice(2);
  if (!input || !suite || !sundials || !cmake || !receipt) throw Error('Expected IF97_DIR SUITE_ARCHIVE SUNDIALS_ARCHIVE CMAKE NEW_RECEIPT');
  const result = await runFixedVolumeAdmission(input, suite, sundials, cmake, receipt, previous);
  console.log(JSON.stringify({ passed: result.passed, failure: result.failure, used: result.used, receipt }));
  if (!result.passed) process.exitCode = 1;
}
