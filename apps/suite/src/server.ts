import { z } from 'zod'
import { moduleIdSchema, workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import type { SuiteCoordinator } from './coordinator.ts'
import type { SuiteWorkspace } from './model.ts'

const createWorkspaceSchema = z.object({
  displayName: z.string().trim().min(1).max(256),
  moduleIds: z.array(moduleIdSchema).optional(),
}).strict()

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')

const workspaceCard = (workspace: SuiteWorkspace): string => `
  <article>
    <h2>${escapeHtml(workspace.displayName)}</h2>
    <code>${workspace.id}</code>
    <ul>${workspace.modules.map(module => `
      <li>
        <strong>${escapeHtml(module.moduleId)}</strong>: ${module.status}
        ${module.workspaceUrl ? `<a href="${escapeHtml(module.workspaceUrl)}">Open</a>` : ''}
        ${module.error ? `<small>${escapeHtml(module.error)}</small>` : ''}
      </li>`).join('')}
    </ul>
    <button data-retry="${workspace.id}">Retry provisioning</button>
  </article>`

const renderIndex = (workspaces: ReadonlyArray<SuiteWorkspace>): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Samsinn + Leitbild Workspaces</title>
<style>
body{font:16px/1.5 system-ui;margin:0 auto;max-width:900px;padding:2rem;color:#19202a;background:#f5f7fa}
header,article,form{background:white;border:1px solid #dce2e8;border-radius:12px;padding:1rem 1.25rem;margin-bottom:1rem}
label{display:block;margin-bottom:.5rem}input{padding:.6rem;min-width:20rem}button{padding:.6rem .9rem}li{margin:.45rem 0}a{margin-left:.75rem}small{display:block;color:#9b2c2c}code{font-size:.8rem}
</style></head><body>
<header><h1>Workspaces</h1><p>Coordinated entry points; each application remains independently usable.</p></header>
<form id="create"><label>Name <input name="displayName" required maxlength="256"></label><button>Create Workspace</button></form>
<main>${workspaces.map(workspaceCard).join('') || '<p>No Workspaces yet.</p>'}</main>
<script>
document.querySelector('#create').addEventListener('submit',async event=>{event.preventDefault();const displayName=new FormData(event.target).get('displayName');const response=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({displayName})});if(!response.ok){alert(await response.text());return}location.reload()})
document.querySelectorAll('[data-retry]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;const response=await fetch('/api/workspaces/'+button.dataset.retry+'/provision',{method:'POST'});if(!response.ok){alert(await response.text());return}location.reload()}))
</script></body></html>`

const errorResponse = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status })

export const createSuiteServer = (config: {
  readonly coordinator: SuiteCoordinator
  readonly port?: number
  readonly bindHost?: string
}) => Bun.serve({
  port: config.port ?? 3100,
  hostname: config.bindHost ?? '0.0.0.0',
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        const workspaces = await config.coordinator.list()
        return Response.json({ status: 'ok', workspaces: workspaces.length })
      }
      if (url.pathname === '/' && request.method === 'GET') {
        return new Response(renderIndex(await config.coordinator.list()), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      if (url.pathname === '/api/workspaces' && request.method === 'GET') {
        return Response.json({ workspaces: await config.coordinator.list() })
      }
      if (url.pathname === '/api/workspaces' && request.method === 'POST') {
        const body = createWorkspaceSchema.parse(await request.json())
        return Response.json({
          workspace: await config.coordinator.create({
            displayName: body.displayName,
            ...(body.moduleIds === undefined ? {} : { moduleIds: body.moduleIds }),
          }),
        }, { status: 201 })
      }
      const provisionMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/provision$/)
      if (provisionMatch && request.method === 'POST') {
        const id = workspaceIdSchema.parse(decodeURIComponent(provisionMatch[1] ?? ''))
        return Response.json({ workspace: await config.coordinator.provision(id) })
      }
      const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/)
      if (workspaceMatch && request.method === 'GET') {
        const id = workspaceIdSchema.parse(decodeURIComponent(workspaceMatch[1] ?? ''))
        const workspace = await config.coordinator.get(id)
        return workspace
          ? Response.json({ workspace })
          : errorResponse(404, 'workspace_not_found', 'Workspace not found')
      }
      return errorResponse(404, 'route_not_found', 'Route not found')
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        return errorResponse(400, 'invalid_request', error.message)
      }
      if (error instanceof Error && error.message.startsWith('Workspace not found:')) {
        return errorResponse(404, 'workspace_not_found', error.message)
      }
      return errorResponse(500, 'internal_error', error instanceof Error ? error.message : String(error))
    }
  },
})
