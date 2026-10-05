/** Offline Rust kernel primitive admission. Pinned private IF97 input, no live installation.
 * Usage: bun apps/world/scripts/reference-design-rust-storage.ts IF97_DIR NEW_RECEIPT.json
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeIf97HeaderSha256, nativeIf97LicenseSha256, nativeIf97Source } from './reference-design-if97-primitives';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export async function runRustStorageAdmission(inputDirectory: string, receiptPath: string) {
  const input = resolve(inputDirectory), output = resolve(receiptPath);
  try { await readFile(output); throw Error('Receipt exists; refusing overwrite'); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (sha(await readFile(join(input, 'IF97.h'))) !== nativeIf97HeaderSha256
    || sha(await readFile(join(input, 'LICENSE'))) !== nativeIf97LicenseSha256)
    throw Error('Pinned IF97 input identity mismatch');
  const root = resolve(import.meta.dir, '../native/process-plant');
  const bridge = await readFile(join(root, 'src/if97-bridge.cpp'), 'utf8');
  const primitives = nativeIf97Source(true);
  const scratch = await mkdtemp(join(tmpdir(), 'ld01-rust-storage-'));
  await writeFile(join(scratch, 'if97-bridge.cpp'), `${primitives}\n${bridge}`, { flag:'wx' });
  const began = performance.now();
  const environment = {...process.env,LEITBILD_IF97_DIR:input,
    LEITBILD_IF97_BRIDGE_DIR:scratch,CARGO_TARGET_DIR:join(scratch,'target')};
  async function execute(command: string[]) {
    const remaining = 60_000-(performance.now()-began);
    if (remaining<=0) return {command,stdout:'',stderr:'Aggregate native primitive allowance exhausted',
      exitCode:null,timedOut:true};
    const child = Bun.spawn(command,{stdout:'pipe',stderr:'pipe',env:environment});
    let timedOut = false;
    const timer = setTimeout(() => {timedOut=true;child.kill();},remaining);
    const [stdout,stderr,exitCode] = await Promise.all([
      new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
    ]).finally(() => clearTimeout(timer));
    return {command,stdout,stderr,exitCode,timedOut};
  }
  const toolchains = await Promise.all([execute(['rustc','--version']),execute(['c++','--version'])]);
  const tests = await execute(['cargo','test','--release','--manifest-path',join(root,'Cargo.toml')]);
  const commands: Awaited<ReturnType<typeof execute>>[] = [];
  if (tests.exitCode===0&&!tests.timedOut) {
    const stages = [
      ['cargo','build','--release','--examples','--manifest-path',join(root,'Cargo.toml')],
      ['c++','-std=c++17','-O2','-fPIC','-c',join(scratch,'if97-bridge.cpp'),'-I',input,'-o',join(scratch,'bridge.o')],
      ['c++','-std=c++17','-O3',join(root,'tests/storage-cost.cpp'),join(scratch,'bridge.o'),'-o',join(scratch,'cpp-cost')],
      [join(scratch,'cpp-cost')],
      [join(scratch,'target/release/examples/storage-cost')],
    ];
    for (const command of stages) {
      const result = await execute(command);
      commands.push(result);
      if (result.exitCode!==0||result.timedOut) break;
    }
  }
  const costRows = commands.filter(c=>c.command.length===1&&c.exitCode===0)
    .flatMap(c=>c.stdout.trim().split('\n').map(line=>JSON.parse(line) as {
      language:string;width:number;checksum:number;seconds:number;tuples:number}));
  const matched = costRows.length===12 && costRows.filter(r=>r.language==='cpp')
    .every((r,i)=>Math.abs(r.checksum-costRows.filter(s=>s.language==='rust')[i]!.checksum)<=Math.abs(r.checksum)*1e-12);
  const files = ['Cargo.toml','Cargo.lock','build.rs','src/lib.rs','src/if97-bridge.cpp','tests/storage.rs',
    'tests/storage-cost.cpp','examples/storage-cost.rs'];
  const artifacts = await Promise.all(files.map(async file => ({file,sha256:sha(await readFile(join(root,file)))})));
  const receipt = {schema:'ld01-offline-rust-storage-admission',recordedAt:new Date().toISOString(),
    passed:tests.exitCode===0&&!tests.timedOut&&commands.every(c=>c.exitCode===0&&!c.timedOut)&&matched,
    allowanceSeconds:60,elapsedSeconds:(performance.now()-began)/1000,
    upstream:{headerSha256:nativeIf97HeaderSha256,licenseSha256:nativeIf97LicenseSha256},
    artifacts,wrapperSha256:sha(await readFile(import.meta.path)),
    primitiveSha256:sha(await readFile(new URL('./reference-design-if97-primitives.ts',import.meta.url))),
    generatedBridgeSha256:sha(await readFile(join(scratch,'if97-bridge.cpp'))),scratch,
    toolchains,tests,commands,costRows,matched,
    scope:'Real stable-liquid values, conservative K/Q/PE storage, analytic local Jacobian and nearby known-branch recovery. Matched local cost probe only; no trajectory, phase recovery, source calibration, coupled plant or target-host throughput claim.'};
  await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return receipt;
}
if (import.meta.main) {
  const [input,receipt] = process.argv.slice(2);
  if (!input||!receipt) throw Error('Expected pinned IF97 directory and NEW receipt path');
  const result = await runRustStorageAdmission(input,receipt);
  console.log(JSON.stringify({passed:result.passed,elapsedSeconds:result.elapsedSeconds,receipt}));
  if (!result.passed) process.exitCode=1;
}
