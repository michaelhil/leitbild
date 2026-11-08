import { normalize, resolve } from 'node:path'
import { createPlanningModuleApi, type PlanningDemoPort } from './module-api.ts'
import type { PlanningService } from './service.ts'

const contentType = (path: string): string => path.endsWith('.js') ? 'application/javascript; charset=utf-8'
  : path.endsWith('.css') ? 'text/css; charset=utf-8'
    : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream'

export const createPlanningServer = (config: {
  readonly service: PlanningService
  readonly demos?: PlanningDemoPort
  readonly port?: number
  readonly host?: string
  readonly uiDistPath?: string
}) => {
  const handle = createPlanningModuleApi(config)
  const uiRoot = resolve(config.uiDistPath ?? `${import.meta.dir}/ui/dist`)
  return Bun.serve({
    hostname: config.host ?? '127.0.0.1', port: config.port ?? 3102,
    async fetch(request) {
      const url = new URL(request.url)
      try {
        if (url.pathname === '/health' && request.method === 'GET') return Response.json({ status: 'ok', moduleId: 'planning' })
        const response = await handle(request, url)
        if (response) return response
        if (request.method === 'GET' && /^\/workspaces\/[0-9a-f-]+\/planning$/.test(url.pathname)) {
          const index = Bun.file(`${uiRoot}/index.html`)
          if (!await index.exists()) return Response.json({ error: { code: 'planning_ui_unavailable', message: 'Build the Planning UI before opening it', retryable: false } }, { status: 503 })
          return new Response(index, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
        }
        if (request.method === 'GET' && url.pathname.startsWith('/assets/planning/')) {
          const path = normalize(`${uiRoot}${url.pathname}`)
          if (!path.startsWith(`${uiRoot}/assets/planning/`)) return new Response('Forbidden', { status: 403 })
          const file = Bun.file(path)
          if (await file.exists()) return new Response(file, { headers: { 'Content-Type': contentType(path), 'Cache-Control': 'public, max-age=31536000, immutable' } })
        }
        return new Response('Not found', { status: 404 })
      } catch (error) {
        console.error('Planning request failed', error)
        return Response.json({ error: { code: 'planning_internal_error', message: 'Planning request failed; inspect the service log', retryable: false } }, { status: 500 })
      }
    },
  })
}
