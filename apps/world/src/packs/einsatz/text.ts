/**
 * Browser-safe wording helpers the map presentation, the dispatch surface
 * and the engine's own wording share. They import nothing, so the browser
 * loads no engine with them.
 */

/** "4:20", or "1:04:20" past an hour; never negative. */
export const clockText = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds))
  const [hours, minutes, rest] = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
  const pad = (value: number) => value.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

/** The icon of a track the side has not identified: a catalogue icon that says nothing of what was seen. */
export const contactIcon = 'circle-question-mark'
