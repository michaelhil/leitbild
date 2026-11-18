import { createDiagramVersions, flowDirection, withFlowDirection, type FlowDirection } from './viewer-model.ts'
import { anchoredScroll, boundedZoom, fitDiagramScale, svgDiagramSize, type DiagramSize } from './viewport.ts'
import { installDiagramStyles } from './viewer-styles.ts'

export interface MermaidAskRequest {
  readonly source: string
  readonly initialSource: string
  readonly instruction: string
  readonly messageId: string
  readonly blockIndex: number
  /** Stops waiting in this view; it does not cancel the Agent's server turn. */
  readonly signal: AbortSignal
}
export type MermaidAskHandler = (request: MermaidAskRequest) => Promise<{ readonly source: string; readonly label?: string }>
let askHandler: MermaidAskHandler | undefined
export const setMermaidAskHandler = (handler: MermaidAskHandler): void => {
  askHandler = handler
}

interface ViewerOptions {
  readonly rawSource: string
  readonly source: string
  readonly svg: string
  readonly messageId?: string
  readonly blockIndex: number
  readonly renderSource: (rawSource: string) => Promise<{ readonly source: string; readonly svg: string }>
}

const makeButton = (label: string, action: () => void): HTMLButtonElement => {
  const button = document.createElement('button')
  button.type = 'button'; button.textContent = label; button.addEventListener('click', action)
  return button
}

export const createMermaidViewer = (options: ViewerOptions) => {
  installDiagramStyles()
  const versions = createDiagramVersions(options.rawSource)
  const element = document.createElement('div')
  element.className = 'diagram-viewer'
  element.dataset.mermaidSource = options.source
  const controls = document.createElement('div')
  controls.className = 'diagram-controls'
  controls.setAttribute('aria-label', 'Diagram viewing controls')
  const viewport = document.createElement('div')
  viewport.className = 'diagram-viewport'; viewport.tabIndex = 0
  viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'Diagram. Scroll to navigate; plus and minus zoom; zero shows natural size; F fits.')
  const stage = document.createElement('div'); stage.className = 'diagram-stage'
  viewport.append(stage)
  const status = document.createElement('div')
  status.className = 'diagram-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
  let size: DiagramSize = { width: 1, height: 1 }
  let scale = 1
  let fitted = true
  let renderEpoch = 0
  let themeEpoch = 0
  let dialog: HTMLDialogElement | undefined
  let askAbort: AbortController | undefined
  let disposed = false
  let editorDraft: string | undefined
  let requestInProgress = false
  let dialogObserver: MutationObserver | undefined
  let restoreButton: HTMLButtonElement | undefined
  const placeholder = document.createElement('p')
  placeholder.className = 'diagram-dialog-note'; placeholder.textContent = 'Diagram open in viewer.'
  const scaleLabel = document.createElement('output'); scaleLabel.className = 'diagram-scale'
  scaleLabel.setAttribute('aria-label', 'Diagram zoom')
  const announce = (message = '', error = false): void => { status.textContent = message; status.dataset.error = String(error) }

  const updateScale = (next: number, fit = false): void => {
    const old = scale
    const anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2
    const left = anchoredScroll(viewport.scrollLeft, anchorX, old, next)
    const top = anchoredScroll(viewport.scrollTop, anchorY, old, next)
    scale = next; fitted = fit
    stage.style.width = `${size.width * scale}px`; stage.style.height = `${size.height * scale}px`
    scaleLabel.textContent = `${Math.round(scale * 1000) / 10}%`
    viewport.scrollLeft = fit ? 0 : left; viewport.scrollTop = fit ? 0 : top
  }
  const fit = (): void => {
    if (viewport.clientWidth <= 0) return
    // Inline fit uses the existing 60vh budget; expanded fit uses its actual canvas.
    const height = dialog ? viewport.clientHeight : Math.max(80, window.innerHeight * 0.6)
    updateScale(fitDiagramScale(size, { width: viewport.clientWidth, height }), true)
  }
  const zoom = (factor: number): void => updateScale(boundedZoom(scale * factor))
  const minus = makeButton('−', () => zoom(1 / 1.25)); minus.setAttribute('aria-label', 'Zoom out diagram')
  const plus = makeButton('+', () => zoom(1.25)); plus.setAttribute('aria-label', 'Zoom in diagram')
  const fitButton = makeButton('Fit', fit)
  const natural = makeButton('100%', () => updateScale(1)); natural.title = 'Natural size: read the text without fitting the whole diagram'
  const expand = makeButton('Expand', () => open())
  const edit = makeButton('Edit source', () => { open(); showEditor() })
  controls.append(minus, scaleLabel, plus, fitButton, natural, expand, edit)
  element.append(controls, viewport, status)

  const setSvg = (svgText: string): void => {
    const holder = document.createElement('div'); holder.innerHTML = svgText
    const svg = holder.querySelector('svg')
    if (!(svg instanceof SVGSVGElement)) throw new Error('The renderer returned no diagram.')
    const nextSize = svgDiagramSize(svg)
    svg.setAttribute('role', 'img')
    if (!svg.querySelector('title') && !svg.getAttribute('aria-label')) svg.setAttribute('aria-label', 'Mermaid diagram; its editable source is available in the viewer.')
    size = nextSize
    stage.replaceChildren(svg)
    if (fitted) fit()
    else updateScale(scale)
  }
  setSvg(options.svg)
  const resizeObserver = new ResizeObserver(() => { if (fitted && !disposed) fit() })
  resizeObserver.observe(viewport)
  viewport.addEventListener('keydown', event => {
    if (event.target !== viewport || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25) }
    else if (event.key === '-') { event.preventDefault(); zoom(1 / 1.25) }
    else if (event.key === '0') { event.preventDefault(); updateScale(1) }
    else if (event.key.toLowerCase() === 'f') { event.preventDefault(); fit() }
    // Native scrolling handles arrows, PageUp/PageDown, mouse wheel and touch.
  })

  const editor = document.createElement('section'); editor.className = 'diagram-editor'; editor.hidden = true
  const sourceLabel = document.createElement('label'); sourceLabel.textContent = 'Mermaid source (changes stay in this view)'
  const textarea = document.createElement('textarea'); textarea.setAttribute('aria-label', 'Mermaid source')
  textarea.spellcheck = false
  textarea.addEventListener('input', () => { editorDraft = textarea.value })
  sourceLabel.append(textarea)
  const editorActions = document.createElement('div'); editorActions.className = 'diagram-actions'
  const apply = makeButton('Apply', () => { void applyDraft() })
  const cancel = makeButton('Cancel edit', () => { renderEpoch++; apply.disabled = false; editorDraft = undefined; editor.hidden = true; refreshVersions(); edit.focus() })
  editorActions.append(apply, cancel); editor.append(sourceLabel, editorActions)
  const versionControls = document.createElement('div'); versionControls.className = 'diagram-actions'
  const versionLabel = document.createElement('span'); versionLabel.className = 'diagram-version-label'
  const previous = makeButton('Previous', () => { void selectVersion(versions.selected() - 1) })
  const next = makeButton('Next', () => { void selectVersion(versions.selected() + 1) })
  const directionLabel = document.createElement('label'); directionLabel.textContent = 'Direction '
  const direction = document.createElement('select'); direction.setAttribute('aria-label', 'Flowchart direction')
  for (const [value, label] of [['TD', 'Top to bottom'], ['LR', 'Left to right'], ['BT', 'Bottom to top'], ['RL', 'Right to left']]) {
    const option = document.createElement('option'); option.value = value!; option.textContent = label!; direction.append(option)
  }
  directionLabel.append(direction)
  versionControls.append(previous, next, versionLabel, directionLabel)
  const refreshVersions = (): void => {
    previous.disabled = versions.selected() === 0; next.disabled = versions.selected() === versions.count() - 1
    versionLabel.textContent = `Versions in this view: ${versions.selected() + 1} of ${versions.count()} · ${versions.current().label}`
    const current = flowDirection(versions.current().source)
    direction.disabled = current === undefined || editorDraft !== undefined
    direction.value = current ?? 'TD'
  }
  const commitRendered = (rendered: { source: string; svg: string }): void => {
    setSvg(rendered.svg); element.dataset.mermaidSource = rendered.source; refreshVersions()
  }
  const renderCandidate = async (source: string, label: string): Promise<boolean> => {
    const epoch = ++renderEpoch
    const themeAtStart = themeEpoch
    try {
      const rendered = await options.renderSource(source)
      if (disposed || epoch !== renderEpoch) return false
      // Validate dimensions before mutating committed source/history.
      const probe = document.createElement('div'); probe.innerHTML = rendered.svg
      const svg = probe.querySelector('svg')
      if (!(svg instanceof SVGSVGElement)) throw new Error('The renderer returned no diagram.')
      svgDiagramSize(svg)
      versions.add(source, label)
      commitRendered(rendered); announce('Diagram updated in this view. The original chat message is unchanged.')
      if (themeAtStart !== themeEpoch) void retheme()
      return true
    } catch (error) {
      if (!disposed && epoch === renderEpoch) announce(`Could not apply the change: ${error instanceof Error ? error.message : String(error)} The previous diagram is retained.`, true)
      return false
    }
  }
  const applyDraft = async (): Promise<void> => {
    apply.disabled = true
    if (await renderCandidate(textarea.value, 'Source edit')) { editorDraft = undefined; editor.hidden = true; refreshVersions() }
    apply.disabled = false
  }
  const showEditor = (): void => {
    textarea.value = editorDraft ?? versions.current().source
    editorDraft = textarea.value; editor.hidden = false; refreshVersions(); textarea.focus()
  }
  const selectVersion = async (index: number): Promise<void> => {
    if (editorDraft !== undefined) { announce('Apply or cancel the source draft before changing versions.', true); return }
    const old = versions.selected()
    if (!versions.select(index)) return
    const epoch = ++renderEpoch
    const themeAtStart = themeEpoch
    try {
      const rendered = await options.renderSource(versions.current().source)
      if (disposed || epoch !== renderEpoch) return
      commitRendered(rendered); announce()
      if (themeAtStart !== themeEpoch) void retheme()
    } catch (error) {
      if (epoch !== renderEpoch) return
      versions.select(old); refreshVersions()
      announce(`Could not show that version: ${error instanceof Error ? error.message : String(error)}`, true)
    }
  }
  direction.addEventListener('change', () => {
    const source = withFlowDirection(versions.current().source, direction.value as FlowDirection)
    if (source === undefined) { announce('Only an explicit flowchart or graph root direction can be changed here.', true); return }
    void renderCandidate(source, 'Direction change').then(() => refreshVersions())
  })
  refreshVersions()

  const askForm = document.createElement('form'); askForm.className = 'diagram-ask'; askForm.hidden = true
  const askLabel = document.createElement('label'); askLabel.textContent = 'Ask the Agent to change this diagram'
  const instruction = document.createElement('textarea'); instruction.rows = 2; instruction.required = true
  instruction.placeholder = 'For example: add the error paths'
  askLabel.append(instruction)
  const askActions = document.createElement('div'); askActions.className = 'diagram-actions'
  const ask = makeButton('Ask Agent', () => {}); ask.type = 'submit'
  const stop = makeButton('Stop waiting', () => {
    askAbort?.abort(); announce('Stopped waiting here. The Agent may still reply in the chat.'); requestInProgress = false; updateAsk()
  })
  stop.title = 'Stops waiting in this viewer; does not cancel the Agent’s work'
  stop.hidden = true
  askActions.append(ask, stop); askForm.append(askLabel, askActions)
  const updateAsk = (): void => {
    askForm.hidden = askHandler === undefined || options.messageId === undefined
    ask.disabled = requestInProgress; instruction.disabled = requestInProgress
    stop.hidden = !requestInProgress
  }
  askForm.addEventListener('submit', event => {
    event.preventDefault()
    if (!askHandler || !options.messageId || requestInProgress || !instruction.value.trim()) return
    if (editorDraft !== undefined) { announce('Apply or cancel the source draft before asking for another change.', true); return }
    const controller = new AbortController(); askAbort?.abort(); askAbort = controller
    const baseline = versions.change(), baselineRender = renderEpoch, source = versions.current().source
    const handler = askHandler
    requestInProgress = true; updateAsk(); announce('Waiting for the Agent. Its reply is also saved in the chat.')
    void (async () => {
      try {
        const candidate = await handler({ source, initialSource: options.rawSource, instruction: instruction.value.trim(), messageId: options.messageId!, blockIndex: options.blockIndex, signal: controller.signal })
        if (controller.signal.aborted || disposed) return
        const themeAtStart = themeEpoch
        const rendered = await options.renderSource(candidate.source)
        if (controller.signal.aborted || disposed) return
        const probe = document.createElement('div'); probe.innerHTML = rendered.svg
        const svg = probe.querySelector('svg')
        if (!(svg instanceof SVGSVGElement)) throw new Error('The Agent returned no renderable diagram.')
        svgDiagramSize(svg)
        // A direction/source change can still be rendering when this reply
        // arrives. Treat that newer intent as a conflict before it commits.
        const activate = versions.change() === baseline && renderEpoch === baselineRender && editorDraft === undefined
        versions.add(candidate.source, candidate.label ?? 'Agent change', activate)
        if (activate) {
          renderEpoch++; commitRendered(rendered); announce('Agent change applied. Previous versions remain in this view.')
          if (themeAtStart !== themeEpoch) void retheme()
        }
        else { refreshVersions(); announce('Agent change added as a version. Your newer edit or selection was kept; use Next to review it.') }
      } catch (error) {
        // Closing / Stop waiting intentionally abandons this observer, not the server turn.
        if (!controller.signal.aborted && !disposed) announce(`Agent change failed: ${error instanceof Error ? error.message : String(error)} The current diagram is retained.`, true)
      } finally {
        if (askAbort === controller) { askAbort = undefined; requestInProgress = false; updateAsk() }
      }
    })()
  })
  updateAsk()

  const cleanupDialog = (): void => {
    if (!dialog) return
    askAbort?.abort(); requestInProgress = false; updateAsk()
    dialogObserver?.disconnect(); dialogObserver = undefined
    const old = dialog; dialog = undefined
    element.replaceChildren(controls, viewport, status)
    expand.hidden = false; old.remove(); fit()
    if (!disposed && element.isConnected) (restoreButton ?? expand).focus({ preventScroll: true })
  }
  const open = (): void => {
    if (disposed || dialog) return
    updateAsk()
    restoreButton = document.activeElement instanceof HTMLButtonElement ? document.activeElement : expand
    const nextDialog = document.createElement('dialog'); dialog = nextDialog
    nextDialog.className = 'diagram-dialog'
    const shell = document.createElement('div'); shell.className = 'diagram-dialog-shell'
    const header = document.createElement('header'); header.className = 'diagram-dialog-header'
    const title = document.createElement('h2'); title.className = 'diagram-dialog-title'; title.textContent = 'Diagram viewer'
    const titleId = `diagram-viewer-title-${options.blockIndex}-${Math.random().toString(36).slice(2, 9)}`
    title.id = titleId; nextDialog.setAttribute('aria-labelledby', titleId)
    const headerActions = document.createElement('div'); headerActions.className = 'diagram-actions'
    let restoredSize: { width: string; height: string } | undefined
    const maximize = makeButton('Maximize', () => {
      if (!nextDialog.classList.contains('is-maximized')) {
        restoredSize = { width: nextDialog.style.width, height: nextDialog.style.height }
        nextDialog.classList.add('is-maximized'); maximize.textContent = 'Restore size'
      } else {
        nextDialog.classList.remove('is-maximized')
        nextDialog.style.width = restoredSize?.width ?? ''; nextDialog.style.height = restoredSize?.height ?? ''
        maximize.textContent = 'Maximize'
      }
    })
    const fullscreen = makeButton('Full screen', () => {
      void (async () => {
        try {
          if (document.fullscreenElement === shell) await document.exitFullscreen()
          else await shell.requestFullscreen()
        } catch (error) { announce(`Full screen is unavailable: ${error instanceof Error ? error.message : String(error)}`, true) }
      })()
    })
    fullscreen.disabled = !document.fullscreenEnabled || typeof shell.requestFullscreen !== 'function'
    if (fullscreen.disabled) fullscreen.title = 'This browser or embedding page does not permit full screen. Maximize still enlarges this viewer within the chat pane.'
    const fullscreenChanged = (): void => {
      fullscreen.textContent = document.fullscreenElement === shell ? 'Exit full screen' : 'Full screen'
      if (fitted) fit()
    }
    document.addEventListener('fullscreenchange', fullscreenChanged)
    nextDialog.addEventListener('close', () => { document.removeEventListener('fullscreenchange', fullscreenChanged) }, { once: true })
    const close = makeButton('Close', () => {
      void (async () => {
        if (document.fullscreenElement === shell) {
          try { await document.exitFullscreen() }
          catch (error) { announce(`Could not exit full screen: ${error instanceof Error ? error.message : String(error)}`, true) }
        }
        nextDialog.close()
      })()
    }); close.setAttribute('aria-label', 'Close diagram viewer')
    headerActions.append(maximize, fullscreen, close); header.append(title, headerActions)
    const body = document.createElement('div'); body.className = 'diagram-dialog-body'
    const note = document.createElement('p'); note.className = 'diagram-dialog-note'
    note.textContent = '100% reads text at natural size. Scroll to navigate. Versions and source edits stay in this view.'
    expand.hidden = true
    body.append(controls, note, viewport, status, versionControls, editor, askForm)
    shell.append(header, body); nextDialog.append(shell)
    element.replaceChildren(placeholder)
    document.body.append(nextDialog)
    nextDialog.addEventListener('close', cleanupDialog, { once: true })
    nextDialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
      const focusable = [...nextDialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')]
        .filter(node => node.getClientRects().length > 0)
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    })
    let backdropPress = false
    nextDialog.addEventListener('pointerdown', event => { backdropPress = event.target === nextDialog })
    nextDialog.addEventListener('click', event => { if (event.target === nextDialog && backdropPress) nextDialog.close() })
    nextDialog.showModal(); close.focus(); fit()
    dialogObserver = new MutationObserver(() => { if (!element.isConnected) dispose() })
    dialogObserver.observe(document.body, { childList: true, subtree: true })
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true; renderEpoch++; askAbort?.abort(); resizeObserver.disconnect()
    if (dialog?.open) dialog.close()
    cleanupDialog()
  }
  const retheme = async (): Promise<void> => {
    const theme = ++themeEpoch, version = versions.change()
    try {
      const rendered = await options.renderSource(versions.current().source)
      if (disposed || theme !== themeEpoch) return
      if (version !== versions.change()) { await retheme(); return }
      commitRendered(rendered)
    } catch (error) {
      if (!disposed && theme === themeEpoch) announce(`Could not update the diagram theme: ${error instanceof Error ? error.message : String(error)} The previous diagram is retained.`, true)
    }
  }
  return {
    element,
    dispose,
    retheme,
  }
}
