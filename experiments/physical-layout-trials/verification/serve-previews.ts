/** Local-only independent visual review of actual saved-source outputs. */
import { resolve } from 'node:path'

const args = Object.fromEntries(Bun.argv.slice(2).map(arg => {
  const equal = arg.indexOf('=')
  if (!arg.startsWith('--') || equal < 0) throw Error('Use --native=/path --ifc=/path --port=43125')
  return [arg.slice(2, equal), arg.slice(equal + 1)]
}))
const root = resolve(import.meta.dir, '..')
const nativeRoot = resolve(args.native ?? `${root}/native/output/base/delivery`)
const ifcRoot = resolve(args.ifc ?? `${root}/ifc/output/baseline`)
const files: Record<string, string> = {
  '/native-lower.svg': `${nativeRoot}/plan-lower.svg`,
  '/native-operating.svg': `${nativeRoot}/plan-operating.svg`,
  '/ifc-lower.svg': `${ifcRoot}/plan-lower.svg`,
  '/ifc-operating.svg': `${ifcRoot}/plan-operating.svg`,
}
for (const file of Object.values(files)) if (!await Bun.file(file).exists()) throw Error(`Missing saved-source output: ${file}`)
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Saved-source architectural review</title><style>body{margin:0;background:#eeeae1;color:#233833;font:15px system-ui}header{padding:14px 20px;background:#fff}main{padding:16px}nav{display:flex;gap:16px;flex-wrap:wrap}article{background:white;padding:12px;margin:16px 0}img{width:100%;height:auto}h1{font-size:22px}a{color:#12605d}p{max-width:85ch}footer{padding:16px}</style><header><h1>Saved-source architectural review</h1><p>Actual source-derived outputs. Native and IFC are independent contenders. Layouts are illustrative; functional checks and visual equivalence are separate evidence.</p><nav><a href="#native">Native source</a><a href="#ifc">IFC source</a><a href="http://127.0.0.1:43124/?scene=native&backend=native">Native-source 3D</a><a href="http://127.0.0.1:43124/?scene=ifc&backend=babylon">IFC-source 3D</a></nav></header><main>${['native','ifc'].map(owner=>`<article id="${owner}"><h2>${owner === 'native' ? 'Native declarative source' : 'IFC source'}</h2><p>Lower-level plan · <a href="/${owner}-lower.svg">full SVG</a></p><img src="/${owner}-lower.svg" alt="${owner} source-derived lower floor plan"><p>Operating deck · <a href="/${owner}-operating.svg">full SVG</a></p><img src="/${owner}-operating.svg" alt="${owner} source-derived operating deck"></article>`).join('')}</main><footer>Research preview · no live plant data · exact source/output hashes are retained in the trial receipts.</footer></html>`
const server = Bun.serve({hostname: '127.0.0.1',port: Number(args.port ?? 43125),async fetch(request) {
  const path = new URL(request.url).pathname
  if (path === '/') return new Response(html, {headers: {'content-type':'text/html; charset=utf-8'}})
  const file = files[path]
  return file ? new Response(Bun.file(file), {headers: {'content-type':'image/svg+xml'}}) : new Response('Not found', {status:404})
}})
console.log(`Saved-source preview: ${server.url}`)
