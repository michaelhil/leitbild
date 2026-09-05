import { expect, test } from 'bun:test'
import { createToolRegistry } from '../core/tool-registry.ts'
import { buildToolSupport } from '../agents/spawn.ts'
import { createToolSurface } from './index.ts'
import type { LLMProvider } from '../core/types/llm.ts'

test('selection is enforced for native and attempted hidden family calls', async () => {
  const registry = createToolRegistry()
  const executed: string[] = []
  for (const name of ['filesystem__read', 'filesystem__write', 'filesystem__delete', 'pass']) {
    registry.register({ name, description: name, parameters: {type:'object',properties:{}}, execute: async () => {
      executed.push(name); return {success:true}
    } })
  }
  const support = await buildToolSupport(['filesystem__read'], registry, {id:'test',name:'Test'}, {} as LLMProvider)
  expect(support.toolDefinitions!.map(t=>t.function.name)).toEqual(['filesystem__read','pass'])
  const results = await support.toolExecutor!([
    {tool:'fs',arguments:{subcommand:'delete',args:{}}},
    {tool:'filesystem__delete',arguments:{}},
    {tool:'filesystem__read',arguments:{}},
  ], 'room')
  expect(results.map(r=>r.success)).toEqual([false,false,true])
  expect(executed).toEqual(['filesystem__read'])
  expect(registry.has('fs')).toBe(false)
})

test('projection preserves input schemas and observes registry removal', () => {
  const registry = createToolRegistry()
  registry.register({name:'read',description:'read',parameters:{type:'object',properties:{id:{type:'string'}},required:['id']},execute:async()=>({success:true})})
  const surface=createToolSurface({registry,requestedTools:['read']})
  expect(surface.project(undefined)[0]!.function.parameters.required).toEqual(['id'])
  registry.unregister('read')
  expect(surface.project(undefined)).toEqual([])
})
