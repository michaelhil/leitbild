// An object's own states as compact chips on its vignette's title row (plan
// v5 W4.1; the old chips' compactness, UX audit U-03, H5): each its declared
// short label, a word beside it only where the state carries a priority
// (where it sends people, its `note`, else its state word), or where it
// declares no short label (its state word alone, as an operating mode reads).
// Neutral while it carries none; filled at its priority otherwise, emergency
// drawn as alarm (register deviation own-state-chip-emergency-as-alarm);
// dashed with "?" where it is not known and with "—" outside its validity;
// in the low-integrity style while it is stale or its display is frozen.
// Generic: nothing here names what a state is about.
import type { Observation } from '../../../core/observation/model.ts'
import type { VignetteValue } from '../../../features/displays/compose/model.ts'
import { underTitle } from './format.ts'
import { toneOf } from './readout.ts'

export interface StateChipLook {
  readonly text: string
  /** Its fill: the priority it carries at caution or above, emergency as alarm. */
  readonly tone: 'caution' | 'warning' | 'alarm' | null
  /** Notice: bold, no hue. */
  readonly emphasis: boolean
  /** Dashed: not known ("?"), or outside its validity ("—"). */
  readonly mark: 'unknown' | 'outside' | null
  /** Stale, or its display frozen: OpenBridge's low-integrity style. */
  readonly doubtful: boolean
  /** Its whole name and state, where it sends people, and why it stands so (the Pack's words). */
  readonly title: string
  /** What assistive technology reads. */
  readonly label: string
}

const stateWord = (value: VignetteValue, observation: Observation | undefined): string | null => {
  const read = observation?.value
  if (read === null || read === undefined) return null
  return value.states?.find(state => state.value === String(read))?.label ?? (typeof read === 'boolean' ? (read ? 'yes' : 'no') : String(read))
}

/** How an own state reads as a chip under a vignette titled `title`; `frozen`: its display shows the last sample it had. */
export const stateChipLook = (value: VignetteValue, observation: Observation | undefined, title: string, frozen: boolean): StateChipLook => {
  const name = underTitle(value.label, title)
  const quality = observation?.quality
  const word = stateWord(value, observation)
  const mark = quality === 'not-applicable' ? 'outside' : word === null || quality === 'bad' || quality === 'uncertain' ? 'unknown' : null
  const tone = mark === null ? toneOf(observation?.priority) : null
  const note = mark === null && observation?.priority !== 'none' ? observation?.note : undefined
  const told = tone !== null || observation?.priority === 'notice'
  const shown = value.shortLabel ?? (mark === null ? word! : name)
  const text = mark === 'outside' ? `${shown} —` : mark === 'unknown' ? `${shown} ?`
    : value.shortLabel === undefined ? (told && note !== undefined ? `${shown} · ${note}` : shown)
      : told ? `${shown} · ${note ?? word}` : shown
  const reads = mark === 'outside' ? '—' : mark === 'unknown' ? 'not known' : word!
  const state = `${name}: ${reads}${note === undefined ? '' : ` · ${note}`}`
  return {
    text,
    tone: tone === 'critical' ? 'alarm' : tone,
    emphasis: observation?.priority === 'notice',
    mark,
    doubtful: frozen || quality === 'stale',
    title: [state, ...(quality === 'stale' ? ['quality: stale'] : []), ...(observation?.why === undefined ? [] : [observation.why])].join('\n'),
    label: state,
  }
}

/** The order chips stand in: those that read as their state word alone (an operating mode) first, then the others as declared. */
export const chipOrder = <T extends Pick<VignetteValue, 'shortLabel'>>(chips: ReadonlyArray<T>): ReadonlyArray<T> =>
  [...chips.filter(chip => chip.shortLabel === undefined), ...chips.filter(chip => chip.shortLabel !== undefined)]
