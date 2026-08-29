export type ThemeMode = 'light' | 'dark'

const storageKey = 'leitbild.theme'
const themeChangeEventName = 'leitbild:themechange'

const storageAvailable = (): boolean => typeof localStorage !== 'undefined'

const storedTheme = (): ThemeMode | null => {
  if (!storageAvailable()) return null
  try {
    const value = localStorage.getItem(storageKey)
    return value === 'light' || value === 'dark' ? value : null
  } catch (error) {
    console.warn('Unable to read Leitbild theme preference', error)
    return null
  }
}

const systemTheme = (): ThemeMode =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

export const initialTheme = (): ThemeMode => storedTheme() ?? systemTheme()

export const getTheme = (): ThemeMode =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light'

export const setTheme = (mode: ThemeMode): void => {
  document.documentElement.classList.toggle('dark', mode === 'dark')
  try {
    localStorage.setItem(storageKey, mode)
  } catch (error) {
    console.warn('Unable to store Leitbild theme preference', error)
  }
  window.dispatchEvent(new CustomEvent<ThemeMode>(themeChangeEventName, { detail: mode }))
}

export const toggleTheme = (): ThemeMode => {
  const next = getTheme() === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}
