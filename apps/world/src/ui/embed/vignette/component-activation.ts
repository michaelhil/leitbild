import type { FlowItem } from './flow-symbols.ts'
import { refObjectId } from '../../../core/model/alerts.ts'

export type ComponentActivation =
  | { readonly kind: 'faceplate'; readonly key: string }
  | { readonly kind: 'target'; readonly element: string; readonly name: string }
  | { readonly kind: 'chooser' }
  | { readonly kind: 'none' }

/** A drawn group is inspected as a group; a continuation names other equipment. */
export const componentActivation = (item: Pick<FlowItem, 'id' | 'kind' | 'targets'>): ComponentActivation => {
  if (item.targets.length === 0) return { kind: 'none' }
  if (item.kind !== 'stop') return { kind: 'faceplate', key: item.id }
  if (item.targets.length > 1) return { kind: 'chooser' }
  const target = item.targets[0]!
  return { kind: 'target', element: target.element, name: target.label }
}

/** One activation per physical key press, matching a button's Enter/Space intent. */
export const componentActivationKey = (event: Pick<KeyboardEvent, 'key' | 'repeat' | 'defaultPrevented'>): boolean =>
  !event.defaultPrevented && !event.repeat && (event.key === 'Enter' || event.key === ' ')

/** A named values group must identify one exact owner, never a representative from several. */
export const componentValueOwner = (values: ReadonlyArray<{ readonly ref: string } | null>): string | null => {
  const owners = new Set(values.flatMap(value => value === null ? [] : [refObjectId(value.ref)]))
  return owners.size === 1 ? owners.values().next().value! : null
}
