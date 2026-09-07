export const defaultNavigationWidth = 300
export const minimumNavigationWidth = 200

// Preserve a usable reading pane on smaller desktop windows. Mobile uses its
// own stacked layout, but still retains the user's desktop width preference.
export const maximumNavigationWidth = (viewportWidth: number): number =>
  Math.max(minimumNavigationWidth, Math.min(640, viewportWidth - 366))

export const navigationWidth = (requested: number, viewportWidth: number): number =>
  Math.max(minimumNavigationWidth, Math.min(
    Number.isFinite(requested) ? requested : defaultNavigationWidth,
    maximumNavigationWidth(viewportWidth),
  ))
