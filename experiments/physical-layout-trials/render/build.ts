import {dirname,join} from 'node:path';import {createRequire} from 'node:module';import {gzipSync} from 'node:zlib';
const require=createRequire(import.meta.url),lib=dirname(require.resolve('maplibre-gl/package.json'));
const build=await Bun.build({entrypoints:[join(import.meta.dir,'src/app.ts')],outdir:join(import.meta.dir,'dist'),target:'browser',format:'esm',splitting:true,minify:true,naming:{entry:'app.js',chunk:'[name]-[hash].[ext]'}});if(!build.success)throw new AggregateError(build.logs,'Browser build failed');
for(const p of['index.html','styles.css'])await Bun.write(join(import.meta.dir,'dist',p),Bun.file(join(import.meta.dir,p)));
for(const p of['maplibre-gl.css','maplibre-gl-worker.mjs'])await Bun.write(join(import.meta.dir,'dist',p),Bun.file(join(lib,'dist',p)));
const sizes=[];for(const out of build.outputs){const bytes=new Uint8Array(await out.arrayBuffer());sizes.push({file:out.path.split('/').pop(),bytes:bytes.byteLength,gzipBytes:gzipSync(bytes).byteLength});}
await Bun.write(join(import.meta.dir,'dist/build-receipt.json'),JSON.stringify({versions:{maplibre:'6.0.0-11',babylon:'9.23.0',bun:Bun.version},outputs:sizes},null,2));console.log(JSON.stringify(sizes,null,2));
