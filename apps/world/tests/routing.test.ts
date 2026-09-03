import { expect, test } from 'bun:test'
import { geoPointFromLonLat } from '../src/core/model/geo.ts'
import { createRoutingAdapterFromEnv } from '../src/routing/config.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createOsrmRoutingAdapter } from '../src/routing/osrm-adapter.ts'

const request = { from: geoPointFromLonLat(11.38, 59.12), to: geoPointFromLonLat(11.39, 59.13) }
const route = {
  code: 'Ok',
  routes: [{ distance: 1234, duration: 140, geometry: { type: 'LineString', coordinates: [[11.38, 59.12], [11.39, 59.13]] } }],
}

const withServer = async (
  fetch: (request: Request) => Response | Promise<Response>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch })
  try { await run(server.url.href) }
  finally { await server.stop(true) }
}

test('OSRM uses the configured endpoint and validates a real provider response', async () => {
  await withServer(incoming => {
    const url = new URL(incoming.url)
    expect(url.pathname).toBe('/routing/route/v1/driving/11.38,59.12;11.39,59.13')
    expect(url.searchParams.get('alternatives')).toBe('false')
    expect(url.searchParams.get('steps')).toBe('false')
    return Response.json(route)
  }, async baseUrl => {
    const result = await createOsrmRoutingAdapter({ baseUrl: `${baseUrl}routing/` }).route(request)
    expect(result.geometry).toMatchObject(route.routes[0]!.geometry)
    expect(Number(result.distanceM)).toBe(1234)
    expect(result.durationSeconds).toBe(140)
    expect(result.provider).toBe('osrm')
  })
})

test('OSRM deadline includes waiting for response headers and rejects late success', async () => {
  let providerCompleted = false
  await withServer(async () => {
    await Bun.sleep(150)
    providerCompleted = true
    return Response.json(route)
  }, async baseUrl => {
    const result = createOsrmRoutingAdapter({ baseUrl, timeoutMs: 40 }).route(request)
      .then(value => ({ value }), error => ({ error: error as Error }))
    const settled = await result
    expect('error' in settled && settled.error.name).toBe('TimeoutError')
    expect(providerCompleted).toBe(false)
    await Bun.sleep(170)
    expect(providerCompleted).toBe(true)
    expect(await result).toBe(settled)
  })
})

test('OSRM deadline also interrupts a stalled response body', async () => {
  await withServer(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"code":"Ok","routes":[')) },
  }), { headers: { 'content-type': 'application/json' } }), async baseUrl => {
    await expect(createOsrmRoutingAdapter({ baseUrl, timeoutMs: 60 }).route(request)).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})

test('caller cancellation rejects before fetch and during response streaming', async () => {
  let calls = 0
  let announceStarted!: () => void
  const started = new Promise<void>(resolve => { announceStarted = resolve })
  await withServer(() => {
    calls++
    announceStarted()
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } }))
  }, async baseUrl => {
    const adapter = createOsrmRoutingAdapter({ baseUrl })
    const alreadyCancelled = AbortSignal.abort(new DOMException('Cancelled before request', 'AbortError'))
    await expect(adapter.route({ ...request, signal: alreadyCancelled })).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(0)
    const controller = new AbortController()
    const pending = adapter.route({ ...request, signal: controller.signal })
      .then(value => ({ value }), error => ({ error: error as Error }))
    await started
    controller.abort(new DOMException('Caller stopped routing', 'AbortError'))
    const settled = await pending
    expect('error' in settled && settled.error.name).toBe('AbortError')
    expect('error' in settled && settled.error.message).toBe('Caller stopped routing')
    expect(calls).toBe(1)
  })
})

test('OSRM bounds body size with and without Content-Length', async () => {
  for (const declared of [true, false]) {
    await withServer(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
          controller.close()
        } }), declared ? { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } } : {}), async baseUrl => {
      await expect(createOsrmRoutingAdapter({ baseUrl }).route(request)).rejects.toThrow('byte budget')
    })
  }
})

test('OSRM bounds route geometry and rejects malformed or failed provider results', async () => {
  const cases = [
    () => new Response('provider failed', { status: 503 }),
    () => new Response('not json'),
    () => Response.json({ code: 'NoRoute', routes: [] }),
    () => Response.json({ ...route, routes: [{ ...route.routes[0], distance: -1 }] }),
    () => Response.json({ ...route, routes: [{ ...route.routes[0], geometry: { type: 'LineString', coordinates: [[190, 59], [11, 59]] } }] }),
    () => Response.json({ ...route, routes: [{ ...route.routes[0], geometry: { type: 'LineString', coordinates: Array.from({ length: 50_001 }, () => [11, 59]) } }] }),
  ]
  for (const response of cases) await withServer(response, async baseUrl => {
    await expect(createOsrmRoutingAdapter({ baseUrl }).route(request)).rejects.toThrow()
  })
})

test('OSRM does not follow redirects or silently substitute a direct route', async () => {
  await withServer(() => new Response(null, { status: 302, headers: { location: '/elsewhere' } }), async baseUrl => {
    await expect(createOsrmRoutingAdapter({ baseUrl }).route(request)).rejects.toThrow()
  })
})

test('routing validates coordinates, provider config, and configurable finite deadlines', async () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 120_001, 1.2]) {
    expect(() => createOsrmRoutingAdapter({ baseUrl: 'http://localhost:5000', timeoutMs })).toThrow()
  }
  for (const baseUrl of ['ftp://localhost', 'http://user:secret@localhost', 'http://localhost?x=y', 'http://localhost/#fragment']) {
    expect(() => createOsrmRoutingAdapter({ baseUrl })).toThrow()
  }
  for (const value of ['', 'invalid', '0', 'Infinity']) {
    expect(() => createRoutingAdapterFromEnv({ LEITBILD_ROUTING_PROVIDER: 'osrm', LEITBILD_OSRM_URL: 'http://localhost:5000', LEITBILD_ROUTING_TIMEOUT_MS: value })).toThrow()
  }
  let called = false
  await withServer(() => { called = true; return Response.json(route) }, async baseUrl => {
    const malformed = { ...request, from: { ...request.from, coordinates: [Number.NaN, 59] as unknown as typeof request.from.coordinates } }
    await expect(createOsrmRoutingAdapter({ baseUrl }).route(malformed)).rejects.toThrow()
    await expect(createDirectRoutingAdapter().route(malformed)).rejects.toThrow()
    expect(called).toBe(false)
    expect((await createRoutingAdapterFromEnv({ LEITBILD_ROUTING_PROVIDER: 'osrm', LEITBILD_OSRM_URL: baseUrl, LEITBILD_ROUTING_TIMEOUT_MS: '1000' }).route(request)).provider).toBe('osrm')
  })
})

test('the explicitly selected direct model remains available and honours cancellation', async () => {
  const adapter = createRoutingAdapterFromEnv({ LEITBILD_ROUTING_PROVIDER: 'direct' })
  const result = await adapter.route(request)
  expect(result.provider).toBe('direct')
  expect(result.distanceM).toBeGreaterThan(0)
  expect(result.geometry.coordinates).toEqual([request.from.coordinates, request.to.coordinates])
  await expect(adapter.route({ ...request, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
})
