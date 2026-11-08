import { expect, test } from 'bun:test'
import { engineeringRoutes } from './engineering.ts'
import type { RouteContext } from './types.ts'

test('engineering routes use the existing dispatcher path and trusted actor',async()=>{
  const seen:unknown[]=[]
  const actor={kind:'anonymous'}
  const ctx = {
    accessContext: {actor},
    system: {engineering: {
      read: async (...args: unknown[]) => { seen.push(args); return {receipt:{}, sourceStatus:[]} },
      runForPerson: async (...args: unknown[]) => { seen.push(args); return {turnId:'new', toolCallId:'call_1_0', receipt:{}} },
    }},
  } as unknown as RouteContext
  const getPath='/rooms/room%20one/engineering/turn/call_1_0'
  const get=engineeringRoutes.find(route=>route.method==='GET' && route.pattern.test(getPath))!
  const response=await get.handler(new Request(`http://local${getPath}`),getPath.match(get.pattern)!,ctx)
  expect(response.status).toBe(200)
  expect(seen[0]).toEqual(['room one','turn','call_1_0',actor])
  const postPath='/rooms/room%20one/engineering'
  const post=engineeringRoutes.find(route=>route.method==='POST' && route.pattern.test(postPath))!
  const request=new Request(`http://local${postPath}`,{method:'POST',body:JSON.stringify({operation:'run',input:{}})})
  expect((await post.handler(request,postPath.match(post.pattern)!,ctx)).status).toBe(200)
  expect(seen[1]).toEqual(['room one',{operation:'run',input:{}},actor,request.signal])
  const crossed=new Request(`http://local${postPath}`,{method:'POST',headers:{'sec-fetch-site':'cross-site'},body:'{}'})
  expect((await post.handler(crossed,postPath.match(post.pattern)!,ctx)).status).toBe(403)
  const oversized=new Request(`http://local${postPath}`,{method:'POST',body:'x'.repeat(131073)})
  expect((await post.handler(oversized,postPath.match(post.pattern)!,ctx)).status).toBe(413)
  expect(seen).toHaveLength(2)
})
