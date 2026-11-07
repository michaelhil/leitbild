import { ALL_PIECES, pieceLabels, readPrefs, setPieceVisibility } from './message-header-prefs.ts'

export const mountRoomActions = (): void => {
  const button = document.querySelector<HTMLButtonElement>('#btn-room-actions')!
  const actions = document.getElementById('room-actions')!
  const options = document.getElementById('message-display-options')!
  const checkboxes = new Map(ALL_PIECES.map(piece => [piece, document.createElement('input')]))

  for (const [piece, checkbox] of checkboxes) {
    const label = document.createElement('label')
    label.className = 'flex items-center gap-2 py-1'
    checkbox.type = 'checkbox'
    checkbox.onchange = () => {
      setPieceVisibility(piece, checkbox.checked)
      if (piece === 'thinking') {
        for (const details of document.querySelectorAll<HTMLDetailsElement>('details[data-mh-piece="thinking"]')) {
          details.open = checkbox.checked
        }
      }
    }
    label.append(checkbox, pieceLabels[piece])
    options.append(label)
  }

  const setOpen = (open: boolean): void => {
    actions.classList.toggle('hidden', !open)
    button.setAttribute('aria-expanded', String(open))
  }
  button.onclick = () => {
    const open = actions.classList.contains('hidden')
    if (open) {
      const prefs = readPrefs()
      for (const [piece, checkbox] of checkboxes) checkbox.checked = prefs[piece]
    }
    setOpen(open)
  }
  actions.onclick = (event) => {
    if (!(event.target as HTMLElement).closest('[data-close-room-actions]')) return
    if (actions.contains(document.activeElement)) button.focus()
    setOpen(false)
  }
  document.addEventListener('click', event => {
    const target = event.target as Node
    if (!button.contains(target) && !actions.contains(target)) setOpen(false)
  })
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || actions.classList.contains('hidden')) return
    if (actions.contains(document.activeElement)) button.focus()
    setOpen(false)
  })
}
