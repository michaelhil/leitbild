import type { AlertRow } from '../../../features/displays/alerts/rows.ts'

// What a press on an alert row opens, one grammar for every Pack (plan v5 §3, W9.2; UX T10, F29): the element it
// is on (a drawing of the display selects it, else its detail opens after the display), the group it is on as its
// object's element, the observable it judges (its trend or its values), and in a list of several objects' alerts the
// object it is on (its default). A row on the display's own object with none of these opens nothing, and is no
// button.

export type RowTarget =
  | { readonly kind: 'element'; readonly objectId: string; readonly elementId: string }
  | { readonly kind: 'subject'; readonly subject: string }

/** `spansObjects`: the list holds several objects' alerts (the Run's, a collection's), not one object's own. */
export const alertRowTarget = (row: AlertRow, spansObjects: boolean): RowTarget | null => {
  const on = row.alert.subject
  if (on !== undefined) return { kind: 'element', objectId: row.objectId, elementId: 'element' in on ? on.element : on.group }
  if (row.alert.observable !== undefined) return { kind: 'subject', subject: row.alert.observable }
  return spansObjects ? { kind: 'subject', subject: row.objectId } : null
}
