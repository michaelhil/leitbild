/** Selected offline stack only: actual links are evidence, not proof of source
 * correspondence or a redistribution-ready licence package. No installation. */
import {createHash} from 'node:crypto'
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises'
import {basename,dirname,join,resolve} from 'node:path'

const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
export type StackArtifact={path:string,sha256:string,bytes:number,retained:string}
export type SelectedNativeStack={
 binary:StackArtifact,prefix:string,idaLibrary:string,configuration:StackArtifact,
 platform:'darwin'|'linux',inspectionMethod:'otool-L+LC_RPATH'|'ldd',workingDirectory:string,systemLibraryScope:'OS runtime/cache paths exempt from retention',
 linkedLibraries:Array<StackArtifact&{dependencies:string[]}>,systemLibraries:string[],inputs:StackArtifact[],notices:StackArtifact[],
 bindings:Array<{declared:string,resolved:string|null}>,
 loadCommands:Array<{image:string,declared:string,resolved:string}>,
 sourceCorrespondence:'not-verified',redistributionReady:false,
 scope:'verified selected binary/link/configuration identities only;not numerical or licence-completeness admission'
}
export function requireControlledLoaderEnvironment(environment:Readonly<Record<string,string|undefined>>){
 for(const key of Object.keys(environment))if((key.startsWith('DYLD_')||key.startsWith('LD_'))&&environment[key]!==undefined)
  throw Error('Native stack requires an environment without loader overrides: '+key)
}
export function sundialsConfiguration(config:string){
 for(const pattern of [/^#define SUNDIALS_VERSION "7\.5\.0"$/m,/^#define SUNDIALS_DOUBLE_PRECISION 1$/m,
  /^#define SUNDIALS_INT64_T 1$/m,/^#define SUNDIALS_MPI_ENABLED 0$/m])
  if(!pattern.test(config))throw Error('Expected selected SUNDIALS7.5.0 DOUBLE/INT64/non-MPI configuration')
}
/** Declared load paths. Tokens are resolved only by the inspected Darwin
 * image/executable LC_RPATH contract below, never by basename guessing. */
export function nativeLinkPaths(stdout:string,platform:'darwin'|'linux'){
 const paths:string[]=[]
 for(const line of stdout.split('\n').slice(platform==='darwin'?1:0)){
  const text=line.trim();if(!text)continue
  if(platform==='linux'&&/^linux-vdso\S*\s/.test(text))continue
  const path=platform==='darwin'?text.split(' (')[0]!:text.includes('=>')?text.split('=>')[1]!.trim().split(/\s/)[0]!:text.split(/\s/)[0]!
  if(!path.startsWith('/')&&!(platform==='darwin'&&/^@(rpath|loader_path|executable_path)\//.test(path)))throw Error('Unresolved native dependency '+text)
  paths.push(path)
 }
 return [...new Set(paths)]
}
export const nativeSystemLibrary=(path:string,platform:'darwin'|'linux')=>platform==='darwin'
 ?!/^lib(?:sundials_|klu[.]|amd[.]|colamd[.]|btf[.]|suitesparseconfig[.])/.test(basename(path))
  &&(path.startsWith('/usr/lib/')||path.startsWith('/System/Library/'))
 :/^\/(?:usr\/)?lib(?:64)?\//.test(path)
  &&/^(?:lib(?:c|m|dl|pthread|rt|gcc_s|stdc\+\+|c\+\+|c\+\+abi|unwind|util|resolv|atomic)\.so(?:\.\d+)*|ld-(?:linux|musl)[^/]*\.so(?:\.\d+)*)$/.test(basename(path))
const noticePaths=[...['KLU','BTF','AMD','COLAMD','SuiteSparse-config','IF97','LGPL-2.1','BSD-3-Clause'].map(p=>'licenses/'+p+'.txt'),
 'licenses/sources.json','licenses/README.md','SUNDIALS-LICENSE','SUNDIALS-NOTICE']
 .map(p=>resolve(import.meta.dir,'../native/process-plant/qualification',p))
const patchPaths=['../native/process-plant/qualification/ida_consistency.patch',
 '../native/process-plant/qualification/ida_history_trace.patch','reference-design-idas-consistency.patch'].map(p=>resolve(import.meta.dir,p))
export function requireSelectedLibrary(path:string,prefix:string,ida:string,retained:ReadonlySet<string>){
 if(!retained.has(path))throw Error('Actual linked library is not a retained dependency artifact: '+path)
 if(/^libsundials_ida(?:[.])/.test(basename(path))){
  if(path!==ida)throw Error('Actual IDA differs from explicitly selected library: '+path)
 }else if(!path.startsWith(join(prefix,'lib')+'/'))throw Error('Actual native dependency is outside selected prefix: '+path)
}
async function links(path:string,platform:'darwin'|'linux'){
 return nativeLinkPaths(await inspect(platform==='darwin'?['otool','-L',path]:['ldd',path]),platform)
}
async function inspect(command:string[]){
 const child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'})
 const timer=setTimeout(()=>child.kill('SIGKILL'),10_000)
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
 if(code!==0)throw Error('Native dependency inspection failed: '+command.join(' ')+' '+stderr)
 return stdout
}
export function darwinRunpaths(stdout:string){
 const paths=[...stdout.matchAll(/\bcmd LC_RPATH\s+cmdsize \d+\s+path (.+) \(offset \d+\)/g)].map(m=>m[1]!)
 if(paths.length!==[...stdout.matchAll(/\bcmd LC_RPATH\b/g)].length)throw Error('Unparsed Darwin LC_RPATH')
 return paths
}
async function optionalRealpath(path:string){
 try{return await realpath(path)}catch(error){
  if(error&&typeof error==='object'&&'code'in error&&(error.code==='ENOENT'||error.code==='ENOTDIR'))return null
  throw error
 }
}
export function darwinRunpath(path:string,image:string,binary:string,cwd:string){
 if(path.startsWith('@loader_path/'))return resolve(dirname(image),path.slice('@loader_path/'.length))
 if(path==='@loader_path')return dirname(image)
 if(path.startsWith('@executable_path/'))return resolve(dirname(binary),path.slice('@executable_path/'.length))
 if(path==='@executable_path')return dirname(binary)
 if(path.startsWith('@'))throw Error('Unsupported nested Darwin runpath '+path)
 // $ORIGIN is a literal on Darwin, not Linux token expansion.
 return resolve(cwd,path)
}
export async function verifySelectedNativeStack(options:{binary:string,prefix:string,idaLibrary:string,artifacts:string[],directory:string}):Promise<SelectedNativeStack>{
 requireControlledLoaderEnvironment(process.env)
 if(process.platform!=='darwin'&&process.platform!=='linux')throw Error('Selected native stack inspection supports Darwin/Linux only')
 const platform=process.platform,prefix=await realpath(resolve(options.prefix)),ida=await realpath(resolve(options.idaLibrary)),
  binary=await realpath(resolve(options.binary)),directory=resolve(options.directory),
  configPath=await realpath(join(prefix,'include/sundials/sundials_config.h')),
  config=await readFile(configPath)
 sundialsConfiguration(config.toString('utf8'))
 if(!/^libsundials_ida[.]/.test(basename(ida)))throw Error('Selected IDA must identify the IDA shared library')
 const bindings=new Map<string,string|null>([[resolve(options.prefix),prefix],[resolve(options.idaLibrary),ida],[resolve(options.binary),binary]])
 // Caller supplies every external binary/source/notice/patch it wishes to
 // attest. Configured headers are known build inputs, retained automatically.
 const paths=new Set(await Promise.all(options.artifacts.map(p=>realpath(resolve(p)))))
 const notices=await Promise.all(noticePaths.map(p=>realpath(p)))
 for(const path of notices)paths.add(path)
 for(const path of patchPaths)paths.add(await realpath(path))
 for(const name of await Array.fromAsync(new Bun.Glob('**/*.h').scan({cwd:join(prefix,'include')})))
  paths.add(await realpath(join(prefix,'include',name)))
 paths.add(configPath)
 if(!paths.has(ida))throw Error('Explicitly selected IDA is missing from dependency artifacts')
 const snapshots=new Map(await Promise.all([binary,...paths].map(async path=>[path,await readFile(path)] as const)))
 if(sha(snapshots.get(configPath)!)!==sha(config))throw Error('Selected configuration changed before link inspection')
 const pending=[binary],seen=new Set<string>(),dependencies=new Map<string,string[]>(),systems=new Set<string>(),
  loadCommands:Array<{image:string,declared:string,resolved:string}>=[]
 const executableRunpaths=platform==='darwin'?darwinRunpaths(await inspect(['otool','-l',binary])):[],cwd=process.cwd(),prefixLib=await realpath(join(prefix,'lib'))
 const executableRoots=new Set<string>()
 for(const runpath of executableRunpaths){
  const declared=darwinRunpath(runpath,binary,binary,cwd),actual=await optionalRealpath(declared)
  bindings.set(declared,actual);if(actual)executableRoots.add(actual)
 }
 while(pending.length){
  const current=pending.pop()!;if(seen.has(current))continue;seen.add(current)
  const actual:string[]=[]
  const currentLinks=await links(current,platform),imageRunpaths=platform==='darwin'
   ?current===binary?executableRunpaths:darwinRunpaths(await inspect(['otool','-l',current])):[]
  // Do not emulate arbitrary dyld ancestry: any inherited existing library
  // runpath must already be a selected/executable root. Absent literal roots
  // are recorded too, so creating them invalidates the proof.
  if(current!==binary)for(const runpath of imageRunpaths){
   const declared=darwinRunpath(runpath,current,binary,cwd),actual=await optionalRealpath(declared)
   bindings.set(declared,actual)
   if(actual&&actual!==prefixLib&&!executableRoots.has(actual))throw Error('Unsupported inherited Darwin runpath '+declared)
  }
  if(sha(await readFile(current))!==sha(snapshots.get(current)!))throw Error('Native binary changed during link inspection: '+current)
  for(const dependency of currentLinks){
   // Darwin shared-cache system paths need not exist as ordinary files.
   if(nativeSystemLibrary(dependency,platform)){systems.add(dependency);continue}
   let path:string
   if(dependency.startsWith('@rpath/')){
    const roots=[...new Set([...executableRunpaths.map(p=>darwinRunpath(p,binary,binary,cwd)),
     ...imageRunpaths.map(p=>darwinRunpath(p,current,binary,cwd))])],matches=new Set<string>()
    let selectedRoot=false
    for(const root of roots){
     const rootPath=await optionalRealpath(root);bindings.set(root,rootPath)
     if(rootPath===prefixLib)selectedRoot=true
     const candidate=join(root,dependency.slice('@rpath/'.length)),actual=await optionalRealpath(candidate)
     bindings.set(candidate,actual);if(actual)matches.add(actual)
    }
    if(!selectedRoot||matches.size!==1)throw Error('Unresolved or ambiguous selected Darwin runpath '+dependency)
    path=[...matches][0]!
   }else{
    const declared=dependency.startsWith('@')?darwinRunpath(dependency,current,binary,cwd):dependency
    path=await realpath(declared);bindings.set(declared,path)
   }
   loadCommands.push({image:current,declared:dependency,resolved:path})
   if(path===current)continue // dylib's own install name
   requireSelectedLibrary(path,prefix,ida,paths);actual.push(path);pending.push(path)
  }
  dependencies.set(current,actual)
 }
 if(!seen.has(ida))throw Error('Selected IDA is not actually linked by the binary')
 await mkdir(directory)
 const artifacts=new Map<string,StackArtifact>()
 for(const path of [binary,...[...paths].sort()]){
  if(artifacts.has(path))continue
  const bytes=snapshots.get(path)!,retained=join(directory,`${artifacts.size}-${basename(path)}`)
  await writeFile(retained,bytes,{flag:'wx'});artifacts.set(path,{path,retained,sha256:sha(bytes),bytes:bytes.length})
 }
 const manifest:SelectedNativeStack={binary:artifacts.get(binary)!,prefix,idaLibrary:ida,configuration:artifacts.get(configPath)!,
  platform,inspectionMethod:platform==='darwin'?'otool-L+LC_RPATH':'ldd',workingDirectory:cwd,systemLibraryScope:'OS runtime/cache paths exempt from retention',
  linkedLibraries:[...seen].filter(p=>p!==binary).sort().map(path=>({...artifacts.get(path)!,dependencies:dependencies.get(path)!})),
  systemLibraries:[...systems].sort(),inputs:[...artifacts.values()].filter(a=>a.path!==binary),
  notices:notices.map(path=>artifacts.get(path)!),
  bindings:[...bindings].map(([declared,resolved])=>({declared,resolved})),
  loadCommands,
  sourceCorrespondence:'not-verified',redistributionReady:false,
  scope:'verified selected binary/link/configuration identities only;not numerical or licence-completeness admission'}
 if(!await selectedNativeStackUnchanged(manifest))throw Error('Selected native stack changed during inspection/retention')
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
 return manifest
}
export async function selectedNativeStackUnchanged(manifest:SelectedNativeStack){
 requireControlledLoaderEnvironment(process.env)
 return process.cwd()===manifest.workingDirectory
  &&(await Promise.all(manifest.bindings.map(async b=>await optionalRealpath(b.declared)===b.resolved))).every(Boolean)
  &&(await Promise.all([manifest.binary,...manifest.inputs].map(async a=>
  sha(await readFile(a.path))===a.sha256&&sha(await readFile(a.retained))===a.sha256))).every(Boolean)
}
