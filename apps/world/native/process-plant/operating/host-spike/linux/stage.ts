/** TEST-ONLY: stage the Docker build context of the LD-01 host spike's Linux
 * build (Dockerfile beside this file) and run the build. The container
 * compiles; this host-side step gathers hash-checked inputs and generates the
 * IF97 bridge source with the same function reference-design-operating-water
 * compiles on macOS, so both platforms build adapter f59a5dbb.
 *
 * Usage (from apps/world): bun native/process-plant/operating/host-spike/linux/stage.ts <context-dir> [--build]
 * Environment: LD01_IF97_DIRECTORY, LD01_WIKI_ROOT, LD01_OPERATING_HOT_SPINE_PACKET,
 * LD01_SUNDIALS_SOURCE (stock sundials-7.5.0 tree), LD01_SUITESPARSE_TARBALL
 * (SuiteSparse-7.12.3.tar.gz), optional LD01_SETTLED_STATE (joined probe input). */
import {createHash} from 'node:crypto'
import {cp,mkdir,rm,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {metastableBandPage,operatingWaterBridge,parseMetastableBand} from '../../../../../scripts/reference-design-operating-water'
import {ownedBlock,pzrOwners} from '../../../../../scripts/reference-design-operating-pzr'
import {nativeIf97HeaderSha256,nativeIf97LicenseSha256,nativeIf97Revision} from '../../../../../scripts/reference-design-if97-primitives'

const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex')
const required=(name:string)=>{const v=process.env[name];if(!v)throw Error(name+' is required');return resolve(v)}
const run=async(command:string[],cwd:string)=>{
 const child=Bun.spawn(command,{cwd,stdout:'inherit',stderr:'inherit'})
 if(await child.exited!==0)throw Error(command.join(' ')+' failed')
}

const [contextArgument,...flags]=Bun.argv.slice(2)
if(!contextArgument)throw Error('usage: stage.ts <context-dir> [--build]')
const context=resolve(contextArgument),here=dirname(import.meta.path),operating=resolve(here,'../..')
const if97=required('LD01_IF97_DIRECTORY'),wiki=required('LD01_WIKI_ROOT'),packet=required('LD01_OPERATING_HOT_SPINE_PACKET')
const sundials=required('LD01_SUNDIALS_SOURCE'),suitesparse=required('LD01_SUITESPARSE_TARBALL')
await rm(context,{recursive:true,force:true})
await mkdir(join(context,'water'),{recursive:true})
// Pinned inputs, hash-checked here and again inside the build.
const header=await Bun.file(join(if97,'IF97.h')).bytes(),license=await Bun.file(join(if97,'LICENSE')).bytes()
if(hash(header)!==nativeIf97HeaderSha256||hash(license)!==nativeIf97LicenseSha256)throw Error('Pinned IF97 header/license mismatch')
await cp(join(if97,'IF97.h'),join(context,'if97','IF97.h'));await cp(join(if97,'LICENSE'),join(context,'if97','LICENSE'))
await cp(suitesparse,join(context,'sources','SuiteSparse-7.12.3.tar.gz'))
await cp(sundials,join(context,'sources','sundials-7.5.0'),{recursive:true})
// The bridge source and the receipt fields the build completes.
const page=await Bun.file(join(wiki,metastableBandPage)).bytes()
const band=parseMetastableBand(ownedBlock(new TextDecoder().decode(page),pzrOwners.metastable.heading,pzrOwners.metastable.fence))
const source=operatingWaterBridge(band)
await writeFile(join(context,'water','water.cpp'),source)
await writeFile(join(context,'water','water-receipt-partial.json'),JSON.stringify({revision:nativeIf97Revision,headerSha256:nativeIf97HeaderSha256,
 licenseSha256:nativeIf97LicenseSha256,adapterSha256:hash(source),
 metastableBand:{page:metastableBandPage,pageSha256:hash(page),heading:pzrOwners.metastable.heading,fence:pzrOwners.metastable.fence,band}},null,2))
// The crates (sources only) and their vendored dependencies.
for(const [from,to] of [['src','src'],['Cargo.toml','Cargo.toml'],['Cargo.lock','Cargo.lock'],['rust-toolchain.toml','rust-toolchain.toml'],
 ['water-ffi/src','water-ffi/src'],['water-ffi/build.rs','water-ffi/build.rs'],['water-ffi/Cargo.toml','water-ffi/Cargo.toml'],['water-ffi/Cargo.lock','water-ffi/Cargo.lock'],
 ['host-spike/src','host-spike/src'],['host-spike/build.rs','host-spike/build.rs'],['host-spike/Cargo.toml','host-spike/Cargo.toml'],['host-spike/Cargo.lock','host-spike/Cargo.lock']] as const)
 await cp(join(operating,from),join(context,'repo','operating',to),{recursive:true})
await run(['cargo','vendor','--offline','--locked',join(context,'vendor')],join(operating,'host-spike'))
// Probe inputs: packet, the S1 gates page, and optionally the settled state.
const model='world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md'
await cp(packet,join(context,'data','packet.json'))
await cp(join(wiki,model),join(context,'data','wiki',model))
const settled=process.env.LD01_SETTLED_STATE
if(settled)await cp(resolve(settled),join(context,'data','settled-state-600s-1.json'))
await cp(join(here,'Dockerfile'),join(context,'Dockerfile'))
console.log(JSON.stringify({context,adapterSha256:hash(source)}))
if(flags.includes('--build'))
 for(const [target,tag] of [['native','ld01-native-build:bookworm-native'],['host','ld01-native-build:bookworm-host'],['dist','ld01-host-spike:bookworm-dist']] as const)
  await run(['docker','build','--target',target,'-t',tag,'.'],context)
