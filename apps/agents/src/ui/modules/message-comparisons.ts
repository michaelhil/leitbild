import { apiFetch } from './api-client.ts'
import { icon } from './icon.ts'
import { createModal, createCodeBlock, prettyJson } from './modals/detail-modal.ts'
import { showGenerationQueryModal, type GenerationQueryInspection } from './modals/context-modal.ts'
import type { ModelCatalogResponse } from './model-select.ts'
import type { UIMessage } from './render/render-types.ts'

interface Alternative {
  readonly id: string
  readonly model: string
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted'
  readonly content?: string
  readonly error?: string
  readonly startedAt: number | string
  readonly finishedAt?: number | string
  readonly metrics?: Readonly<Record<string, unknown>>
  readonly query?: GenerationQueryInspection['query']
  readonly toolTrace?: ReadonlyArray<unknown>
  readonly calls?: ReadonlyArray<unknown>
  readonly startingInput?: unknown
  readonly nestedQueries?: ReadonlyArray<GenerationQueryInspection['query']>
}

interface ComparisonList {
  readonly available: boolean
  readonly reason?: string
  readonly alternatives: ReadonlyArray<Alternative>
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await apiFetch(path, init)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(body || `Request failed (${response.status})`)
  }
  return await response.json() as T
}

export const pinnedComparisonModels = (catalog: ModelCatalogResponse) => catalog.providers.flatMap(provider =>
  provider.models.filter(model => model.pinned).map(model => {
    const routable = provider.availability.sub === 'ok' || provider.availability.sub === 'backoff'
    const knownCapacity = Number.isFinite(model.contextMax) && model.contextMax > 0
    return {
      value: `${provider.name}:${model.id}`,
      label: `${model.label ?? model.id} · ${provider.name}`,
      available: routable && knownCapacity,
      reason: !routable ? provider.availability.reason
        : !knownCapacity ? 'Context capacity is unknown; refresh the provider model catalog or choose another model.'
        : provider.availability.reason,
    }
  }),
)

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
// Preserve the viewed tab through ordinary room rerenders; never stores answers
// or changes which version participates in model context.
const viewedAlternatives = new Map<string, string>()

// A viewport observer prevents an HTTP request for every historical card.
// Disconnected cards are removed by the same observer's DOM lifecycle cleanup.
const visibleCards = new Map<HTMLElement, () => void>()
let viewport: IntersectionObserver | undefined
let removals: MutationObserver | undefined
const onVisible = (card: HTMLElement, load: () => void): void => {
  if (!viewport) {
    viewport = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const element = entry.target as HTMLElement
        const callback = visibleCards.get(element)
        visibleCards.delete(element)
        viewport!.unobserve(element)
        callback?.()
      }
    })
    removals = new MutationObserver(() => {
      for (const card of visibleCards.keys()) {
        if (card.isConnected) continue
        viewport!.unobserve(card)
        visibleCards.delete(card)
      }
    })
    removals.observe(document.body, { childList: true, subtree: true })
  }
  visibleCards.set(card, load)
  viewport.observe(card)
}

export const mountMessageComparisons = (
  card: HTMLElement,
  message: UIMessage,
  renderMarkdown: (host: HTMLElement, text: string) => void,
): void => {
  const path = `/rooms/${encodeURIComponent(message.roomId!)}/messages/${encodeURIComponent(message.id)}/comparisons`
  const toolbar = document.createElement('div')
  toolbar.className = 'flex items-center gap-2 mb-1'
  const tabs = document.createElement('div')
  tabs.className = 'flex items-center gap-1 overflow-x-auto min-w-0 flex-1'
  const compare = document.createElement('button')
  compare.className = 'icon-btn text-text-subtle hover:text-accent ml-auto shrink-0'
  compare.title = 'Compare another model · independent read-only task rerun'
  compare.setAttribute('aria-label', 'Compare another model')
  compare.appendChild(icon('refresh-cw', { size: 14 }))
  toolbar.append(tabs, compare)
  const original = document.createElement('div')
  original.append(...Array.from(card.childNodes))
  const alternativeBody = document.createElement('div')
  alternativeBody.hidden = true
  const error = document.createElement('div')
  error.className = 'text-xs text-danger my-1'
  error.setAttribute('role', 'alert')
  const retry = document.createElement('button')
  retry.className = 'btn btn-ghost text-xs'
  retry.textContent = 'Retry loading comparisons'
  retry.hidden = true
  retry.onclick = () => { void refresh().catch(report) }
  card.append(toolbar, error, retry, original, alternativeBody)
  let list: ComparisonList | undefined
  let selected = viewedAlternatives.get(path)
  let loading: Promise<void> | undefined
  let polling: ReturnType<typeof setTimeout> | undefined
  let renderedVersion = ''
  let selector: HTMLElement | undefined

  const report = (failure: unknown): void => { error.textContent = errorText(failure); retry.hidden = false }

  const inspect = async (id: string): Promise<void> => {
    try {
      const detail = await request<Alternative>(`${path}/${encodeURIComponent(id)}`)
      if (detail.query) {
        const { query, calls, startingInput, nestedQueries, ...generation } = detail
        showGenerationQueryModal({
          messageId: message.id,
          traceId: detail.id,
          query,
          generation,
          executionCalls: calls,
          startingInput,
          nestedQueries,
        })
      } else {
        const modal = createModal({ title: 'Comparison execution', width: 'max-w-4xl' })
        const note = document.createElement('p')
        note.textContent = 'No final model request is available yet. This record shows the execution information currently retained.'
        modal.scrollBody.append(note, createCodeBlock(prettyJson(detail), '65vh'))
        document.body.appendChild(modal.overlay)
      }
    } catch (failure) { report(failure) }
  }

  const render = (): void => {
    const item = list?.alternatives.find(item => item.id === selected)
    if (!item) { selected = undefined; viewedAlternatives.delete(path) }
    tabs.replaceChildren()
    if (list && list.alternatives.length > 0) {
      const addTab = (label: string, id?: string): void => {
        const row = document.createElement('span')
        row.className = 'inline-flex shrink-0 items-center'
        const tab = document.createElement('button')
        tab.className = `btn btn-ghost text-xs max-w-64 truncate ${selected === id ? 'text-accent bg-surface-muted' : ''}`
        tab.textContent = label
        tab.title = label
        tab.setAttribute('aria-pressed', String(selected === id))
        tab.onclick = () => {
          selected = id
          if (id) viewedAlternatives.set(path, id)
          else viewedAlternatives.delete(path)
          render()
        }
        row.appendChild(tab)
        if (id) {
          const remove = document.createElement('button')
          remove.className = 'icon-btn text-text-muted hover:text-danger'
          remove.title = 'Delete comparison (cancels it if running)'
          remove.setAttribute('aria-label', `Delete ${label} comparison`)
          remove.appendChild(icon('x', { size: 12 }))
          remove.onclick = async () => {
            if (!confirm('Delete this comparison? Running work will be cancelled. The original conversation will not change.')) return
            remove.disabled = true
            try {
              const response = await apiFetch(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' })
              if (!response.ok) throw new Error(await response.text())
              if (selected === id) { selected = undefined; viewedAlternatives.delete(path) }
              await refresh()
            } catch (failure) { report(failure); remove.disabled = false }
          }
          row.appendChild(remove)
        }
        tabs.appendChild(row)
      }
      addTab('Original · in conversation')
      for (const item of list.alternatives) addTab(`${item.status === 'running' ? '◌ ' : ''}${item.model}`, item.id)
    }
    original.hidden = !!item
    alternativeBody.hidden = !item
    const version = JSON.stringify(item)
    if (!item || version === renderedVersion) return
    renderedVersion = version
    alternativeBody.replaceChildren()
    const note = document.createElement('p')
    note.className = 'text-xs text-text-subtle mb-2'
    note.textContent = `Read-only comparison · not in conversation · live data as observed during this rerun. Original: ${new Date(message.timestamp).toLocaleString()}. Rerun: ${new Date(item.startedAt).toLocaleString()}.`
    alternativeBody.appendChild(note)
    const actions = document.createElement('div')
    actions.className = 'flex items-center gap-2 mb-2 text-xs'
    const state = document.createElement('span')
    state.textContent = `${item.model} · ${item.status}`
    if (item.status === 'running') {
      const spinner = icon('refresh-cw', { size: 14 })
      spinner.classList.add('animate-spin')
      actions.appendChild(spinner)
      const cancel = document.createElement('button')
      cancel.className = 'btn btn-ghost text-xs'
      cancel.textContent = 'Cancel'
      cancel.onclick = async () => {
        cancel.disabled = true
        try {
          await request(`${path}/${encodeURIComponent(item.id)}/cancel`, { method: 'POST' })
          await refresh()
        } catch (failure) { report(failure); cancel.disabled = false }
      }
      actions.appendChild(cancel)
    }
    const inspection = document.createElement('button')
    inspection.className = 'icon-btn'
    inspection.title = 'Inspect comparison prompt, tools and generation'
    inspection.setAttribute('aria-label', inspection.title)
    inspection.appendChild(icon('info', { size: 14 }))
    inspection.onclick = () => { void inspect(item.id) }
    actions.append(state, inspection)
    alternativeBody.appendChild(actions)
    if (item.error) {
      const failure = document.createElement('p')
      failure.className = 'text-danger text-xs'
      failure.textContent = item.error
      alternativeBody.appendChild(failure)
    }
    if (item.content) {
      const content = document.createElement('div')
      content.className = 'text-text'
      renderMarkdown(content, item.content)
      alternativeBody.appendChild(content)
    }
    if (item.metrics) {
      const brief = document.createElement('p')
      brief.className = 'text-[10px] text-text-subtle mt-2'
      const counters = ['promptTokens', 'completionTokens', 'modelCalls', 'cacheRead', 'cacheCreation', 'cacheMiss']
        .flatMap(key => typeof item.metrics![key] === 'number' ? [`${key}: ${(item.metrics![key] as number).toLocaleString()}`] : [])
      brief.textContent = counters.length ? counters.join(' · ') : 'Generation metadata available below.'
      alternativeBody.appendChild(brief)
      const metrics = document.createElement('details')
      const summary = document.createElement('summary')
      summary.className = 'text-xs text-text-subtle cursor-pointer mt-2'
      summary.textContent = 'Generation and cache usage'
      metrics.append(summary, createCodeBlock(prettyJson(item.metrics)))
      alternativeBody.appendChild(metrics)
    }
  }

  const refresh = (): Promise<void> => {
    if (loading) return loading
    loading = (async () => {
      if (polling) clearTimeout(polling)
      list = await request<ComparisonList>(path)
      error.textContent = ''
      retry.hidden = true
      render()
      if (list.alternatives.some(item => item.status === 'running') && card.isConnected) {
        // Progress is human-facing; one request per second avoids streaming a
        // second room protocol. Polling ends on completion or card unmount.
        polling = setTimeout(() => { if (card.isConnected) void refresh().catch(report) }, 1000)
      }
    })().finally(() => { loading = undefined })
    return loading
  }

  compare.onclick = async () => {
    if (selector?.isConnected) return
    compare.disabled = true
    try {
      await refresh()
      const modal = createModal({ title: 'Compare another model', width: 'max-w-xl' })
      selector = modal.overlay
      document.body.appendChild(modal.overlay)
      const note = document.createElement('p')
      note.className = 'text-sm mb-3'
      note.textContent = 'Runs the complete task with independent tool choices, using its saved starting input and current live data. Read-only: actions cannot execute. Results stay outside conversation history. Different observation times mean this is not an identical-world benchmark. Each run uses provider tokens.'
      modal.scrollBody.appendChild(note)
      if (!list?.available) {
        const reason = document.createElement('p')
        reason.textContent = list?.reason ?? 'This message has no captured task-start input.'
        modal.scrollBody.appendChild(reason)
        return
      }
      const status = document.createElement('p')
      status.className = 'text-xs text-text-subtle'
      status.textContent = 'Loading pinned models…'
      modal.scrollBody.appendChild(status)
      try {
        const models = pinnedComparisonModels(await request<ModelCatalogResponse>('/models'))
        status.textContent = models.length ? 'Choose a pinned model. Pins are managed in Settings → Providers.' : 'No models are pinned. Pin models in Settings → Providers, then reopen this selector.'
        for (const model of models) {
          const button = document.createElement('button')
          button.className = 'btn btn-ghost block w-full text-left my-1'
          button.textContent = model.available ? model.label : `${model.label} — ${model.reason}`
          button.disabled = !model.available
          button.title = model.available ? model.value : model.reason
          button.onclick = async () => {
            const buttons = [...modal.scrollBody.querySelectorAll('button')].map(button => ({ button, disabled: button.disabled }))
            buttons.forEach(({ button }) => { button.disabled = true })
            status.textContent = 'Starting comparison…'
            try {
              const item = await request<Alternative>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.value }) })
              modal.close()
              // Finish any pre-creation poll before selecting the new result;
              // its older response must not clear the newly selected tab.
              await loading?.catch(report)
              selected = item.id
              viewedAlternatives.set(path, item.id)
              await refresh().catch(report)
            } catch (failure) {
              status.textContent = errorText(failure)
              buttons.forEach(({ button, disabled }) => { button.disabled = disabled })
            }
          }
          modal.scrollBody.appendChild(button)
        }
      } catch (failure) { status.textContent = errorText(failure) }
    } catch (failure) { report(failure) }
    finally { compare.disabled = false }
  }

  onVisible(card, () => { void refresh().catch(report) })
}
