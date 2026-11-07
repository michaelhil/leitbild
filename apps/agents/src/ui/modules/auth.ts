import { apiFetch } from './api-client.ts'

type AuthState = 'ready' | 'token-required' | 'unavailable'
type TokenResult = 'ready' | 'rejected' | 'rate-limited' | 'unavailable'

export const readAuthState = async (): Promise<AuthState> => {
  try {
    const response = await apiFetch('/auth', { cache: 'no-store' })
    if (!response.ok) return 'unavailable'
    const status = await response.json() as { authEnabled?: unknown; authenticated?: unknown } | null
    if (typeof status?.authEnabled !== 'boolean' || typeof status.authenticated !== 'boolean') return 'unavailable'
    if (status.authenticated) return 'ready'
    return status.authEnabled ? 'token-required' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export const submitAccessToken = async (token: string): Promise<TokenResult> => {
  try {
    const response = await apiFetch('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (response.status === 401) return 'rejected'
    if (response.status === 429) return 'rate-limited'
    return response.ok && (await response.json())?.ok === true ? 'ready' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export const ensureAuthenticated = async (): Promise<void> => {
  let state = await readAuthState()
  if (state === 'ready') return

  const dialog = document.querySelector<HTMLDialogElement>('#sandbox-access')!
  const title = document.getElementById('sandbox-access-title')!
  const status = document.getElementById('sandbox-access-status')!
  const form = dialog.querySelector('form')!
  const token = form.querySelector('input')!
  const submit = form.querySelector('button')!
  const retry = dialog.querySelector<HTMLButtonElement>('#sandbox-access-retry')!
  dialog.oncancel = event => event.preventDefault()
  let tokenError = ''

  while (state !== 'ready') {
    const requiresToken = state === 'token-required'
    title.textContent = requiresToken ? 'Sandbox access' : 'Could not reach Agents'
    status.textContent = requiresToken
      ? tokenError || 'Enter the access token to use this Leitbild sandbox.'
      : 'Check your connection and try again.'
    form.hidden = !requiresToken
    retry.hidden = requiresToken
    if (!dialog.open) dialog.showModal()

    if (requiresToken) {
      submit.disabled = false
      token.focus()
      const value = await new Promise<string>(resolve => {
        form.onsubmit = event => {
          event.preventDefault()
          const value = token.value.trim()
          if (!value) return
          submit.disabled = true
          token.value = ''
          resolve(value)
        }
      })
      const result = await submitAccessToken(value)
      if (result === 'ready' || result === 'unavailable') state = result
      tokenError = result === 'rejected' ? 'Token rejected. Try again.'
        : result === 'rate-limited' ? 'Too many attempts. Wait a moment and try again.' : ''
    } else {
      retry.disabled = false
      retry.focus()
      await new Promise<void>(resolve => {
        retry.onclick = () => {
          retry.disabled = true
          resolve()
        }
      })
      state = await readAuthState()
      tokenError = ''
    }
  }

  dialog.close()
}
