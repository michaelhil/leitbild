import {expect,test} from 'bun:test'
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {darwinRunpath,darwinRunpaths,nativeLinkPaths,nativeSystemLibrary,requireSelectedLibrary,requireControlledLoaderEnvironment,selectedNativeStackUnchanged,sundialsConfiguration,verifySelectedNativeStack} from './reference-design-native-stack'

const configuration='#define SUNDIALS_VERSION "7.5.0"\n#define SUNDIALS_DOUBLE_PRECISION 1\n#define SUNDIALS_INT64_T 1\n#define SUNDIALS_MPI_ENABLED 0\n'
test('selected header configuration refuses a different version/precision/index/MPI ABI',()=>{
 sundialsConfiguration(configuration)
 for(const [a,b] of [['7.5.0','7.6.0'],['DOUBLE_PRECISION 1','DOUBLE_PRECISION 0'],['INT64_T 1','INT64_T 0'],['MPI_ENABLED 0','MPI_ENABLED 1']])
  expect(()=>sundialsConfiguration(configuration.replace(a!,b!))).toThrow()
})
test('loader override presence refuses even empty values without leaking their contents',()=>{
 requireControlledLoaderEnvironment({PATH:'/test',RUSTFLAGS:'-L native=/test'})
 for(const key of ['DYLD_LIBRARY_PATH','DYLD_INSERT_LIBRARIES','LD_LIBRARY_PATH','LD_PRELOAD','LD_AUDIT'])
  for(const value of ['', 'private-value']){
   let message='';try{requireControlledLoaderEnvironment({[key]:value})}catch(error){message=String(error)}
   expect(message).toContain(key);expect(message).not.toContain('private-value')
  }
})
test('link parsing retains absolute closure and refuses unresolved/missing libraries',()=>{
 expect(nativeLinkPaths('binary:\n\t/private/libIDA.dylib (compatibility version 0.0.0, current version 0.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n','darwin'))
  .toEqual(['/private/libIDA.dylib','/usr/lib/libSystem.B.dylib'])
 expect(nativeLinkPaths('linux-vdso.so.1 (0x0)\n libx.so => /private/libx.so (0x1)\n /lib64/ld-linux-x86-64.so.2 (0x2)\n','linux'))
  .toEqual(['/private/libx.so','/lib64/ld-linux-x86-64.so.2'])
 expect(nativeLinkPaths('x:\n @rpath/libida.dylib (compatibility version 0.0.0)','darwin')).toEqual(['@rpath/libida.dylib'])
 for(const [line,platform] of [['x:\n @unknown/libida.dylib (compatibility version 0.0.0)','darwin'],['libx.so => not found','linux']] as const)
  expect(()=>nativeLinkPaths(line,platform)).toThrow('Unresolved')
})
test('Darwin runpaths use declared loader/executable roots and leave $ORIGIN literal',()=>{
 expect(darwinRunpaths('cmd LC_RPATH\n cmdsize 96\n path /selected/lib (offset 12)\n')).toEqual(['/selected/lib'])
 expect(()=>darwinRunpaths('cmd LC_RPATH\n cmdsize 96\n wrong /selected/lib')).toThrow('Unparsed')
 expect(darwinRunpath('@loader_path/../lib','/selected/bin/image','/run/bin/main','/cwd')).toBe('/selected/lib')
 expect(darwinRunpath('@executable_path/../lib','/selected/bin/image','/run/bin/main','/cwd')).toBe('/run/lib')
 expect(darwinRunpath('$ORIGIN','/selected/bin/image','/run/bin/main','/cwd')).toBe('/cwd/$ORIGIN')
 expect(()=>darwinRunpath('@rpath/nested','/image','/main','/cwd')).toThrow('nested')
})
test('Linux runtime exemption does not hide system-installed numerical libraries',()=>{
 for(const name of ['libc.so.6','libm.so.6','libstdc++.so.6','libgcc_s.so.1','ld-linux-x86-64.so.2'])
  expect(nativeSystemLibrary('/usr/lib/x86_64-linux-gnu/'+name,'linux')).toBe(true)
 for(const name of ['libklu.so.2','libcholmod.so.5','libumfpack.so.6','libmetis.so','libopenblas.so.0'])
  expect(nativeSystemLibrary('/usr/lib/'+name,'linux')).toBe(false)
 expect(nativeSystemLibrary('/usr/local/lib/libc.so.6','linux')).toBe(false)
})
test('retaining both stock and candidate cannot authorize the wrong selected IDA',()=>{
 const prefix='/private/prefix',candidate='/private/candidate/libsundials_ida.dylib',stock=prefix+'/lib/libsundials_ida.7.dylib',
  core=prefix+'/lib/libsundials_core.7.dylib',retained=new Set([candidate,stock,core,'/other/libklu.dylib'])
 requireSelectedLibrary(candidate,prefix,candidate,retained)
 requireSelectedLibrary(core,prefix,candidate,retained)
 expect(()=>requireSelectedLibrary(stock,prefix,candidate,retained)).toThrow('differs')
 expect(()=>requireSelectedLibrary('/missing/libklu.dylib',prefix,candidate,retained)).toThrow('not a retained')
 expect(()=>requireSelectedLibrary('/other/libklu.dylib',prefix,candidate,retained)).toThrow('outside selected')
})
test('actual link traversal canonicalizes aliases, retains documentary identities, detects mutation',async()=>{
 // Test-only C objects, never executed and not a numerical-library substitute.
 const directory=await mkdtemp(join(tmpdir(),'leitbild-stack-test-'))
 try{
  const prefix=join(directory,'prefix'),include=join(prefix,'include/sundials'),lib=join(prefix,'lib'),
   candidate=join(directory,'candidate'),darwin=process.platform==='darwin',extension=darwin?'dylib':'so'
  await mkdir(include,{recursive:true});await mkdir(lib);await mkdir(candidate)
  await writeFile(join(include,'sundials_config.h'),configuration)
  const ida=join(candidate,'libsundials_ida.'+extension),alias=join(directory,'alias.'+extension),binary=join(directory,'test-link'),
   librarySource=join(directory,'library.c'),binarySource=join(directory,'main.c')
  await writeFile(librarySource,'int stack_test_value(void){return 7;}\n')
  await writeFile(binarySource,'extern int stack_test_value(void); int main(void){return stack_test_value()!=7;}\n')
  for(const command of [darwin?['cc','-dynamiclib',librarySource,'-Wl,-install_name,@rpath/libsundials_ida.dylib','-o',ida]
   :['cc','-shared','-fPIC',librarySource,'-Wl,-soname,'+ida,'-o',ida],
   ['cc',binarySource,ida,...(darwin?['-Wl,-rpath,'+candidate,'-Wl,-rpath,'+lib]:[]),'-o',binary]]){
   const child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'}),stderr=await new Response(child.stderr).text()
   expect(await child.exited,stderr).toBe(0)
  }
  await symlink(ida,alias)
  const manifest=await verifySelectedNativeStack({binary,prefix,idaLibrary:alias,artifacts:[alias],directory:join(directory,'retained')})
  expect(manifest.linkedLibraries.map(q=>q.path)).toEqual([await realpath(ida)])
  expect(manifest.idaLibrary).toBe(await realpath(ida))
  expect(manifest.notices).toHaveLength(12)
  expect(manifest.redistributionReady).toBe(false)
  expect(manifest.sourceCorrespondence).toBe('not-verified')
  expect(await selectedNativeStackUnchanged(manifest)).toBe(true)
  if(darwin){
   const conflict=join(lib,'libsundials_ida.dylib');await writeFile(conflict,await readFile(ida))
   expect(await selectedNativeStackUnchanged(manifest)).toBe(false)
   await expect(verifySelectedNativeStack({binary,prefix,idaLibrary:alias,artifacts:[alias,conflict],directory:join(directory,'ambiguous')})).rejects.toThrow('ambiguous')
   await rm(conflict)
  }
  const config=manifest.configuration
  const originalConfig=await readFile(config.retained)
  await writeFile(config.retained,(await readFile(config.retained,'utf8'))+'changed\n')
  expect(await selectedNativeStackUnchanged(manifest)).toBe(false)
  await writeFile(config.retained,originalConfig)
  const twin=join(directory,'libsundials_ida.twin.'+extension)
  await writeFile(twin,await readFile(ida))
  await rm(alias);await symlink(twin,alias)
  // Old canonical bytes are unchanged; only the next-load binding changed.
  expect(await selectedNativeStackUnchanged(manifest)).toBe(false)
  await rm(alias);await symlink(ida,alias)
  await expect(verifySelectedNativeStack({binary,prefix,idaLibrary:alias,artifacts:[],directory:join(directory,'missing')})).rejects.toThrow('missing from dependency')
 }finally{await rm(directory,{recursive:true,force:true})}
},10_000)
