import { z } from 'zod'
import {
  accessContextSchema,
  capabilityIdSchema,
  createWorkspaceInputSchema,
  experienceIdSchema,
  moduleIdSchema,
  newRequestId,
  platformError,
  renameWorkspaceInputSchema,
  workspaceIdSchema,
  workspaceCapabilityInvocationRequestSchema,
  type ExperienceId,
  type Workspace,
  type WorkspaceExperience,
} from '@samsinn-leitbild/platform-contracts'
import { isHostError } from './errors.ts'
import type { WorkspaceHost } from './host.ts'

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')

const workspaceLabel = (workspace: Workspace): string => workspace.name ?? workspace.id

const shell = (title: string, content: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{font:16px/1.5 system-ui;color:#172033;background:#f3f5f8}*{box-sizing:border-box}body{margin:0 auto;max-width:1000px;padding:2rem}header,article,form,.panel{background:#fff;border:1px solid #d8dee8;border-radius:12px;padding:1rem 1.25rem;margin-bottom:1rem}nav{display:flex;gap:1rem;margin-bottom:1rem}a{color:#3159a7}code{font-size:.8rem;overflow-wrap:anywhere}label{display:block;margin:.6rem 0}input,select,button{font:inherit;padding:.55rem .7rem}button.danger{color:#a32121}ul{padding-left:1.3rem}.failure{color:#a32121}.muted{color:#687386}
</style></head><body><nav><a href="/workspaces">Workspaces</a></nav>${content}</body></html>`

const renderWorkspaceList = (workspaces: ReadonlyArray<Workspace>): string => shell('Workspaces', `
<header><h1>Workspaces</h1><p>Each Workspace has one URL identity and an explicit set of Modules.</p></header>
<form id="create-workspace"><h2>Create Workspace</h2><label>Name (optional) <input name="name" maxlength="256"></label><button>Create</button></form>
<main>${workspaces.map(workspace => `<article><h2><a href="/workspaces/${workspace.id}">${escapeHtml(workspaceLabel(workspace))}</a></h2><code>${workspace.id}</code><p class="muted">${workspace.modules.length} Module${workspace.modules.length === 1 ? '' : 's'}</p></article>`).join('') || '<div class="panel">No Workspaces.</div>'}</main>
<script>
document.querySelector('#create-workspace').addEventListener('submit',async event=>{event.preventDefault();const raw=new FormData(event.target).get('name').trim();const response=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:raw||null})});const body=await response.json();if(!response.ok){alert(body.error.message);return}location.href='/workspaces/'+body.workspace.id})
</script>`)

const moduleList = (workspace: Workspace): string => workspace.modules.map(item => `
<li><strong>${escapeHtml(item.moduleId)}</strong> — ${escapeHtml(item.status)}
${item.failure ? `<div class="failure">${escapeHtml(item.failure.message)}</div><button data-retry="${escapeHtml(item.moduleId)}">Retry</button>` : ''}</li>`).join('') || '<li>No Modules</li>'

const experienceCards = (experiences: ReadonlyArray<WorkspaceExperience>): string => experiences.map(experience => `
<article><h3>${escapeHtml(experience.title)}</h3>${experience.description ? `<p>${escapeHtml(experience.description)}</p>` : ''}
<p>Status: <strong>${experience.status}</strong></p>
${experience.status === 'absent'
  ? `<button data-add-experience="${escapeHtml(experience.id)}">Add</button>`
  : `<button class="danger" data-remove-experience="${escapeHtml(experience.id)}">Remove</button>`}
</article>`).join('') || '<p class="muted">No Experiences are installed in this distribution.</p>'

const renderWorkspace = (workspace: Workspace, experiences: ReadonlyArray<WorkspaceExperience>): string =>
  shell(workspaceLabel(workspace), `
  <header><h1>${escapeHtml(workspaceLabel(workspace))}</h1><code>${workspace.id}</code></header>
  <form id="rename"><h2>Name</h2><label>Optional name <input name="name" maxlength="256" value="${escapeHtml(workspace.name ?? '')}"></label><button>Save</button></form>
  <section><h2>Experiences</h2>${experienceCards(experiences)}</section>
  <article><h2>Technical Modules</h2><ul>${moduleList(workspace)}</ul></article>
  <article><h2>Delete Workspace</h2><p>Deletion also removes Module-owned state. A failed Module cleanup leaves the Workspace visible for retry.</p><button class="danger" id="delete-workspace">Delete</button></article>
  <script>
  const workspaceId=${JSON.stringify(workspace.id)};
  const request=async(url,options)=>{const response=await fetch(url,options);if(response.status===204)return null;const body=await response.json();if(!response.ok)throw new Error(body.error.message);return body};
  document.querySelector('#rename').addEventListener('submit',async event=>{event.preventDefault();const raw=new FormData(event.target).get('name').trim();try{await request('/api/workspaces/'+workspaceId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:raw||null})});location.reload()}catch(error){alert(error.message)}});
  document.querySelectorAll('[data-add-experience]').forEach(button=>button.addEventListener('click',async()=>{try{await request('/api/workspaces/'+workspaceId+'/experiences/'+encodeURIComponent(button.dataset.addExperience),{method:'PUT'});location.reload()}catch(error){alert(error.message);location.reload()}}));
  document.querySelectorAll('[data-remove-experience]').forEach(button=>button.addEventListener('click',async()=>{if(!confirm('Remove this Experience and its unshared Module state?'))return;try{await request('/api/workspaces/'+workspaceId+'/experiences/'+encodeURIComponent(button.dataset.removeExperience),{method:'DELETE'});location.reload()}catch(error){alert(error.message);location.reload()}}));
  document.querySelectorAll('[data-retry]').forEach(button=>button.addEventListener('click',async()=>{try{await request('/api/workspaces/'+workspaceId+'/modules/'+encodeURIComponent(button.dataset.retry)+'/retry',{method:'POST'});location.reload()}catch(error){alert(error.message);location.reload()}}));
  document.querySelector('#delete-workspace').addEventListener('click',async()=>{if(!confirm('Delete this Workspace and all Module-owned state?'))return;try{await request('/api/workspaces/'+workspaceId,{method:'DELETE'});location.href='/workspaces'}catch(error){alert(error.message);location.reload()}});
  </script>`)

const jsonError = (status: number, code: string, message: string, retryable = false, details?: Readonly<Record<string, unknown>>): Response =>
  Response.json(platformError({ code, message, retryable, ...(details === undefined ? {} : { details }) }), { status })

const parseJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json()
  } catch (error) {
    throw error instanceof SyntaxError ? error : new SyntaxError('Request body must be valid JSON')
  }
}

export const createWorkspaceHostServer = (config: {
  readonly host: WorkspaceHost
  readonly initialExperienceIds?: ReadonlyArray<ExperienceId>
  readonly port?: number
  readonly bindHost?: string
}) => Bun.serve({
  port: config.port ?? 3100,
  hostname: config.bindHost ?? '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return Response.json({ status: 'ok', workspaces: config.host.list().length })
      }
      if (url.pathname === '/' && request.method === 'GET') {
        let workspaces = config.host.list()
        if (workspaces.length === 0) {
          const workspace = await config.host.create({ name: null, experienceIds: [...(config.initialExperienceIds ?? [])] })
          return Response.redirect(new URL(`/workspaces/${workspace.id}`, url), 303)
        }
        if (workspaces.length === 1) return Response.redirect(new URL(`/workspaces/${workspaces[0]!.id}`, url), 303)
        return Response.redirect(new URL('/workspaces', url), 303)
      }
      if (url.pathname === '/workspaces' && request.method === 'GET') {
        return new Response(renderWorkspaceList(config.host.list()), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      const workspaceUiMatch = url.pathname.match(/^\/workspaces\/([^/]+)$/)
      if (workspaceUiMatch && request.method === 'GET') {
        const workspaceId = workspaceIdSchema.parse(decodeURIComponent(workspaceUiMatch[1] ?? ''))
        const workspace = config.host.get(workspaceId)
        return workspace
          ? new Response(renderWorkspace(workspace, config.host.experiences(workspaceId)), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
          : new Response(shell('Workspace not found', '<div class="panel"><h1>Workspace not found</h1></div>'), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      if (url.pathname === '/api/modules' && request.method === 'GET') {
        return Response.json({ modules: config.host.installedModuleIds().map(moduleId => ({ id: moduleId })) })
      }
      if (url.pathname === '/api/experiences' && request.method === 'GET') {
        return Response.json({ experiences: config.host.installedExperiences() })
      }
      if (url.pathname === '/api/workspaces' && request.method === 'GET') {
        return Response.json({ workspaces: config.host.list() })
      }
      if (url.pathname === '/api/workspaces' && request.method === 'POST') {
        const input = createWorkspaceInputSchema.parse(await parseJson(request))
        return Response.json({ workspace: await config.host.create(input) }, { status: 201 })
      }
      const invocationMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/capabilities\/([^/]+)\/invoke$/)
      if (invocationMatch && request.method === 'POST') {
        const workspaceId = workspaceIdSchema.parse(decodeURIComponent(invocationMatch[1] ?? ''))
        const capabilityId = capabilityIdSchema.parse(decodeURIComponent(invocationMatch[2] ?? ''))
        const requestInput = workspaceCapabilityInvocationRequestSchema.parse(await parseJson(request))
        const input = {
          ...(requestInput.resource === undefined ? {} : { resource: requestInput.resource }),
          input: requestInput.input,
        }
        const access = accessContextSchema.parse({
          workspaceId,
          requestId: newRequestId(),
          actor: requestInput.actor ?? { kind: 'anonymous' },
          client: { id: 'workspace-host', kind: 'service' },
        })
        return Response.json({ result: await config.host.invoke(workspaceId, capabilityId, input, access) })
      }
      const resourcesMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/resources$/)
      if (resourcesMatch && request.method === 'GET') {
        const workspaceId = workspaceIdSchema.parse(decodeURIComponent(resourcesMatch[1] ?? ''))
        return Response.json(await config.host.resources(workspaceId))
      }
      const capabilitiesMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/capabilities$/)
      if (capabilitiesMatch && request.method === 'GET') {
        const workspaceId = workspaceIdSchema.parse(decodeURIComponent(capabilitiesMatch[1] ?? ''))
        return Response.json(await config.host.capabilities(workspaceId))
      }
      const experienceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/experiences\/([^/]+)$/)
      if (experienceMatch) {
        const workspaceId = workspaceIdSchema.parse(decodeURIComponent(experienceMatch[1] ?? ''))
        const experienceId = experienceIdSchema.parse(decodeURIComponent(experienceMatch[2] ?? ''))
        if (request.method === 'PUT') return Response.json({ experiences: await config.host.addExperience(workspaceId, experienceId) })
        if (request.method === 'DELETE') return Response.json({ experiences: await config.host.removeExperience(workspaceId, experienceId) })
      }
      const experiencesMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/experiences$/)
      if (experiencesMatch && request.method === 'GET') {
        const workspaceId = workspaceIdSchema.parse(decodeURIComponent(experiencesMatch[1] ?? ''))
        return Response.json({ experiences: config.host.experiences(workspaceId) })
      }
      const moduleMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/modules\/([^/]+)(\/retry)?$/)
      if (moduleMatch) {
        const workspaceId = workspaceIdSchema.parse(decodeURIComponent(moduleMatch[1] ?? ''))
        const moduleId = moduleIdSchema.parse(decodeURIComponent(moduleMatch[2] ?? ''))
        const retry = moduleMatch[3] !== undefined
        if (retry && request.method === 'POST') return Response.json({ workspace: await config.host.retryModule(workspaceId, moduleId) })
        if (!retry && request.method === 'PUT') return Response.json({ workspace: await config.host.addModule(workspaceId, moduleId) })
        if (!retry && request.method === 'DELETE') return Response.json({ workspace: await config.host.removeModule(workspaceId, moduleId) })
      }
      const workspaceApiMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/)
      if (workspaceApiMatch) {
        const workspaceId = workspaceIdSchema.parse(decodeURIComponent(workspaceApiMatch[1] ?? ''))
        if (request.method === 'GET') {
          const workspace = config.host.get(workspaceId)
          return workspace ? Response.json({ workspace }) : jsonError(404, 'workspace_not_found', 'Workspace not found')
        }
        if (request.method === 'PATCH') {
          const input = renameWorkspaceInputSchema.parse(await parseJson(request))
          return Response.json({ workspace: config.host.rename(workspaceId, input) })
        }
        if (request.method === 'DELETE') {
          await config.host.delete(workspaceId)
          return new Response(null, { status: 204 })
        }
      }
      return jsonError(404, 'route_not_found', 'Route not found')
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        return jsonError(400, 'invalid_request', error.message)
      }
      if (isHostError(error)) {
        return jsonError(error.status, error.code, error.message, error.retryable, error.details)
      }
      console.error('Workspace Host request failed', error)
      return jsonError(500, 'internal_error', 'Internal Workspace Host error')
    }
  },
})
