/** One frozen offline replacement decision. No change to the retained liquid backend.
 * bun .../reference-design-rust-if97-candidate.ts PINNED_IF97_DIR NEW_RECEIPT.json
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeIf97Primitives, nativeIf97HeaderSha256, nativeIf97LicenseSha256 } from './reference-design-if97-primitives';

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
// Reviewed BEFORE execution: original five plus density anomaly, R1/R3 join and near-critical liquid.
const liquids = [[290,101325],[313.15,15.2e6],[450,15.2e6],[600,15.2e6],[640,20.5e6],
  [277,101325],[623.149,20e6],[623.151,20e6],[647,22.063e6]] as const;
// IAPWS R7-97(2012) Tables5/33. Rounded verification, not a wider liquid operating scope.
const published = [
  {mode:'r1',t:300,x:3e6,values:[.00100215168,115331.273,112324.818,392.294792,4173.01218,1507.73921]},
  {mode:'r1',t:300,x:80e6,values:[.000971180894,184142.828,106448.356,368.563852,4010.08987,1634.69054]},
  {mode:'r1',t:500,x:3e6,values:[.001202418,975542.239,971934.985,2580.41912,4655.80682,1240.71337]},
  {mode:'r3',t:650,x:500,values:[1/500,1863430.19,1812262.79,4054.27273,13893.5717,502.005554]},
  {mode:'r3',t:650,x:200,values:[1/200,2375124.01,2263658.68,4854.38792,44657.9342,383.444594]},
  {mode:'r3',t:750,x:500,values:[1/500,2258688.45,2102069.32,4469.71906,6341.65359,760.696041]},
] as const;
const fields = ['pressure','temperature','density','internalEnergy','enthalpy','entropy','cp','cv',
  'soundSpeed','expansion','compressibility','viscosity','conductivity'];
const absolute = [1,1e-8,1e-8,1e-5,1e-5,1e-6,1e-6,1e-6,1e-6,1e-12,1e-18,1e-12,1e-9];

export async function qualifyRustIf97Candidate(inputDirectory: string, receiptPath: string) {
  const input = resolve(inputDirectory), output = resolve(receiptPath);
  try { await readFile(output); throw Error('Refusing to overwrite existing evidence'); }
  catch(error) { if (!(error && typeof error==='object' && 'code' in error && error.code==='ENOENT')) throw error; }
  if (sha(await readFile(join(input,'IF97.h')))!==nativeIf97HeaderSha256
    || sha(await readFile(join(input,'LICENSE')))!==nativeIf97LicenseSha256) throw Error('Pinned reference identity mismatch');
  const sourcePath = resolve(import.meta.dir,'../native/process-plant/qualification/seuif97.rs');
  const source = await readFile(sourcePath);
  const wrapperIdentity=sha(await readFile(import.meta.path));
  const primitiveIdentity=sha(await readFile(new URL('./reference-design-if97-primitives.ts',import.meta.url)));
  const scratch = await mkdtemp(join(tmpdir(),'ld01-rust-if97-candidate-'));
  const manifest = '[package]\nname="ld01-if97-candidate"\nversion="0.0.0"\nedition="2024"\n'
    +'[dependencies]\nseuif97={version="=2.3.8",default-features=false}\n'
    +'[[bin]]\nname="probe"\npath="probe.rs"\n[profile.release]\nlto="thin"\ncodegen-units=1\n';
  await writeFile(join(scratch,'Cargo.toml'),manifest,{flag:'wx'});
  await writeFile(join(scratch,'probe.rs'),source,{flag:'wx'});
  const cpp = `${nativeIf97Primitives}\n#include <iostream>\n#include <iomanip>\n#include <stdexcept>\n`
    +`double max_forward_p=0,max_dense_endpoint_p_error=0;\nvoid require(bool ok,const std::string& m){if(!ok)throw std::domain_error(m);}\n`
    +`int main(){std::cout<<std::setprecision(17);\n`
    +liquids.map(([t,p])=>`{const auto q=liquid(${t},${p});std::cout<<"["<<q.p<<","<<q.T<<","<<q.rho<<","<<q.u<<","<<q.h<<","<<q.s<<","<<q.cp<<","<<q.cv<<","<<q.w<<","<<q.alpha<<","<<q.kappa<<","<<q.mu<<","<<q.conductivity<<"]\\n";}\n`).join('')+'}\n';
  await writeFile(join(scratch,'reference.cpp'),cpp,{flag:'wx'});
  const began = performance.now();
  async function execute(command: string[]) {
    const remaining=60_000-(performance.now()-began);
    if(remaining<=0) return {command,stdout:'',stderr:'Aggregate qualification allowance exhausted',exitCode:null,timedOut:true};
    const child=Bun.spawn(command,{cwd:scratch,stdout:'pipe',stderr:'pipe'});
    let timedOut=false; const timer=setTimeout(()=>{timedOut=true;child.kill();},remaining);
    const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
      .finally(()=>clearTimeout(timer));
    return {command,stdout,stderr,exitCode,timedOut};
  }
  const args = [...liquids.flatMap(([t,p])=>['liquid',String(t),String(p)]),
    ...published.flatMap(r=>[r.mode,String(r.t),String(r.x)])];
  const commands=[];
  for(const command of [['rustc','--version'],['c++','--version'],
    ['cargo','build','--release','--manifest-path',join(scratch,'Cargo.toml')],
    ['c++','-std=c++17','-O2',join(scratch,'reference.cpp'),'-I',input,'-o',join(scratch,'reference')],
    [join(scratch,'reference')],[join(scratch,'target/release/probe'),...args]]) {
    const result=await execute(command);commands.push(result);
    if(result.exitCode!==0||result.timedOut) break;
  }
  const executed=commands.length===6&&commands.every(c=>c.exitCode===0&&!c.timedOut);
  const reference: number[][]=executed?commands[4]!.stdout.trim().split('\n').map(line=>JSON.parse(line)):[];
  const candidate: {kind:string;values:number[]}[]=executed?commands[5]!.stdout.trim().split('\n').map(line=>JSON.parse(line)):[];
  const comparisons=liquids.map(([t,p],i)=>({temperature:t,pressure:p,fields:fields.map((field,j)=>{
    const a=candidate[i]?.values[j], b=reference[i]?.[j];
    const difference=a===undefined||b===undefined?null:Math.abs(a-b);
    return {field,candidate:a,reference:b,difference,
      passed:difference!==null&&Number.isFinite(difference)&&difference<=absolute[j]!+Math.abs(b!)*1e-6};
  })}));
  const printed=published.map((r,i)=>{
    const q=candidate[liquids.length+i]?.values;
    const actual=q?[1/q[2]!,q[4]!,q[3]!,q[5]!,q[6]!,q[8]!]:[];
    return {mode:r.mode,temperature:r.t,input:r.x,expected:r.values,actual,
      passed:actual.length===6&&actual.every((a,j)=>Number.isFinite(a)&&Math.abs(a/r.values[j]!-1)<=2e-6)};
  });
  let lock:string|null=null;
  try { lock=await readFile(join(scratch,'Cargo.lock'),'utf8'); }
  catch(error) { if (!(error && typeof error==='object' && 'code' in error && error.code==='ENOENT')) throw error; }
  const receipt={schema:'ld01-rust-if97-replacement-decision',recordedAt:new Date().toISOString(),
    executed,accepted:false,unchangedTransportTreatment:false,
    disposition:'Retain current qualified bridge: RustSEUIF972.3.8 has background-only conductivity; not the selected industrial enhancement. No physical law changed.',
    allowanceSeconds:60,elapsedSeconds:(performance.now()-began)/1000,
    criteria:{relative:1e-6,absolute,printedRelative:2e-6,pressureRecoveryPa:1,
      meaning:'Same-law numerical screen, not permission to change a physical correlation. Stop before storage/cost/trajectory/adoption if transport differs.'},
    source:{probeSha256:sha(source),wrapperSha256:wrapperIdentity,
      referenceCppSha256:sha(cpp),primitiveSha256:primitiveIdentity,
      headerSha256:nativeIf97HeaderSha256,licenseSha256:nativeIf97LicenseSha256,
      manifestSha256:sha(manifest),cargoLock:lock,cargoLockSha256:lock?sha(lock):null},
    scratch,commands,comparisons,printed,
    scope:'9 liquid tuples, same-potential R3 refinement and6printed primitive states; no derivative/recovery/phase/trajectory/throughput qualification, no dependency added to plant component.'};
  await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return receipt;
}
if(import.meta.main) {
  const [input,output]=process.argv.slice(2);
  if(!input||!output) throw Error('Expected pinned IF97 directory and NEW receipt path');
  const result=await qualifyRustIf97Candidate(input,output);
  console.log(JSON.stringify({executed:result.executed,accepted:result.accepted,elapsedSeconds:result.elapsedSeconds,
    failedComparisons:result.comparisons.flatMap(c=>c.fields.filter(f=>!f.passed).map(f=>({temperature:c.temperature,pressure:c.pressure,...f}))),
    printedPassed:result.printed.every(r=>r.passed),receipt:output}));
  if(!result.executed) process.exitCode=1;
}
