import { calculationApi, calculationLocation, calculationLocator, calculationRequest } from './engineering/model.ts'
import { renderCalculation } from './engineering/render.ts'

const host = document.getElementById('calculation')
const status = document.getElementById('status')
if (host === null || status === null) throw new Error('The calculation view has no mount point')
const showError = (error: unknown): void => { status.textContent = error instanceof Error ? error.message : String(error); status.setAttribute('role', 'alert') }
const theme = (): void => { const saved = localStorage.getItem('leitbild.theme'); document.documentElement.classList.toggle('dark', saved === 'dark' || (saved === null && matchMedia('(prefers-color-scheme: dark)').matches)) }
theme(); window.addEventListener('storage', event => { if (event.key === 'leitbild.theme') theme() })
// A different retained locator requires a fresh owner read, even when only the
// fragment changes. Rerun's replaceState does not emit this navigation event.
window.addEventListener('hashchange', () => location.reload())

const boot = async (): Promise<void> => {
  const match = location.pathname.match(/^\/workspaces\/([^/]+)\/agents\/embed\/engineering\.result$/)
  if (match === null) throw new Error('The calculation view requires a Workspace URL')
  const workspaceId = decodeURIComponent(match[1]!)
  if (!location.hash.startsWith('#view=')) throw new Error('The calculation view has no execution locator')
  const raw: unknown = JSON.parse(decodeURIComponent(location.hash.slice(6)))
  const original = calculationLocator(raw, workspaceId)
  const api = calculationApi(workspaceId)
  let current = original
  let busy = false
  const open = async (): Promise<void> => {
    host.replaceChildren()
    status.setAttribute('role', 'status'); status.textContent = 'Reading the retained calculation…'
    const { receipt, sourceStatus } = await api.open(current)
    const permalink = calculationLocation(raw, workspaceId, current)
    renderCalculation(host, receipt, sourceStatus, {
      permalink,
      ...(current === original ? {} : { original: () => { current = original; void open().catch(showError) } }),
      run: (edits, refresh) => {
        if (busy) return
        busy = true; host.setAttribute('aria-busy', 'true')
        const controls = [...host.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')].map(control => ({ control, disabled: control.disabled }))
        for (const { control } of controls) control.disabled = true
        status.setAttribute('role', 'status'); status.textContent = refresh ? 'Acquiring current owner inputs and calculating…' : 'Calculating with the retained inputs…'
        const run = async (): Promise<void> => {
          try { const result = await api.run(current.roomId, calculationRequest(receipt, edits, refresh)); current = result.locator; await open() }
          catch (error) { showError(error) }
          finally { busy = false; host.removeAttribute('aria-busy'); for (const { control, disabled } of controls) control.disabled = disabled }
        }
        void run().catch(showError)
      },
    })
    history.replaceState(null, '', permalink)
    status.textContent = 'Retained result. Opening this page did not run a calculation.'
  }
  // The existing display window's ready handshake; no live-control message is handled.
  if (window.parent !== window) window.parent.postMessage({ type: 'world:display-frame-ready' }, location.origin)
  await open()
}
void boot().catch(showError)
