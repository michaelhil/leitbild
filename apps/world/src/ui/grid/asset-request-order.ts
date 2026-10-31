/** An asset read belongs to one Run, Grid, revision and view selection.
 * A newer read retires its predecessor even when A → B → A selects the same
 * asset again. Identity changes retire it before a replacement starts.
 */
export const createGridAssetRequestOrder = (currentIdentity: () => string) => {
  let sequence = 0
  return {
    begin: (): { readonly current: () => boolean } => {
      const request = ++sequence, identity = currentIdentity()
      return { current: () => request === sequence && identity === currentIdentity() }
    },
    dispose: (): void => { sequence++ },
  }
}
