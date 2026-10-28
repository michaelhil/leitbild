import { expect, test } from 'bun:test'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'

// Exercise Svelte's actual component-instance namespace. Two diagrams may draw
// the same owner/local item, at different sizes, in one document.
const moduleUrl = (source: string, filename: string, imports: ReadonlyMap<string, string> = new Map()): string => {
  const code = compile(source, { filename, generate: 'server', runes: true }).js.code.replace(/from (["'])([^"']+)\1/g, (_match, _quote: string, name: string) => {
    const target = imports.get(name) ?? (name.startsWith('.') ? new URL(name, filename).href : import.meta.resolve(name))
    return `from ${JSON.stringify(target)}`
  })
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}

test('repeated vessel item ids in separate component instances keep their own SVG clipping geometry', async () => {
  const path = new URL('../src/ui/embed/vignette/Vessel.svelte', import.meta.url)
  const vessel = moduleUrl(await Bun.file(path).text(), path.href)
  const parent = moduleUrl(`<script>import Vessel from 'vessel-under-test';</script>
    <Vessel id="same-reactor" width={48} height={168} origin={{x:0,y:0}} drawing={{core:null,span:{x:0,width:48},nozzles:[]}} level={100} parts={[]} />
    <Vessel id="same-reactor" width={96} height={216} origin={{x:0,y:0}} drawing={{core:null,span:{x:0,width:96},nozzles:[]}} level={50} parts={[]} />`, import.meta.url, new Map([['vessel-under-test', vessel]]))
  const component = await import(parent)
  const html = render(component.default).body
  const ids = [...html.matchAll(/<clipPath id="([^"]+)"/g)].map(match => match[1]!)
  const uses = [...html.matchAll(/clip-path="url\(#([^\)]+)\)"/g)].map(match => match[1]!)
  expect(ids).toHaveLength(2)
  expect(new Set(ids).size).toBe(2)
  expect(uses).toEqual(ids)
})
