import type { OperationalObject } from '../../core/model/index.ts'
import type { PackObjectPresentation } from '../../core/packs/protocol.ts'

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

export const objectHoverCardHtml = (config: {
  readonly object: OperationalObject
  readonly presentation: PackObjectPresentation
  readonly hasNewInfo: boolean
}): string => {
  const lines = config.presentation.fields
    .map(field => `<div>${escapeHtml(field.label)}: ${escapeHtml(field.value)}</div>`)
    .join('')
  const newInfo = config.hasNewInfo ? '<div class="hover-new-info">New information</div>' : ''
  return `<strong>${escapeHtml(config.object.label)}</strong>${newInfo}${lines}`
}
