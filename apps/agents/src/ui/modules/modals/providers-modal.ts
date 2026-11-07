import { domRefs } from '../app-dom.ts'
import { openOllamaDashboard, updateOllamaHealthUI, wireOllamaDashboard, type OllamaDashboardElements } from '../ollama-dashboard.ts'
import { startProvidersPanel, stopProvidersPanel } from '../panels/providers/index.ts'
import { $ollamaHealth } from '../stores.ts'

const ollamaEls: OllamaDashboardElements = {
  dashboard: domRefs.ollamaDashboard,
  urlSelect: domRefs.ollamaUrlSelect,
  urlInput: domRefs.ollamaUrlInput,
  btnUrlAdd: domRefs.btnOllamaUrlAdd,
  btnUrlDelete: domRefs.btnOllamaUrlDelete,
}

wireOllamaDashboard(ollamaEls)
let stopHealth: (() => void) | undefined
ollamaEls.dashboard.addEventListener('close', () => {
  if (ollamaEls.dashboard.open) return
  stopProvidersPanel()
  stopHealth?.()
  stopHealth = undefined
})

export const openProvidersModal = async (): Promise<void> => {
  if (ollamaEls.dashboard.open) return
  const opening = openOllamaDashboard(ollamaEls)
  stopHealth?.()
  stopHealth = $ollamaHealth.listen(health => {
    if (health) updateOllamaHealthUI(health as unknown as Record<string, unknown>)
  })
  startProvidersPanel()
  await opening
}
