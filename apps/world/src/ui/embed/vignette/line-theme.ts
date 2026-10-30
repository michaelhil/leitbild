import { mediumColorsFromCss, type ThemeVars } from '@oicl/connector-diagram'

/** Connector-diagram's semantic palette, supplied from OpenBridge 2.1 tokens.
 * Its 1.0 CSS helper reads the removed 2.0 pipe names and silently uses day
 * defaults instead. Supply the renderer's public ThemeVars directly; a missing
 * token is an error rather than a pipe drawn in another palette. */
export const lineTheme = (read: (name: string) => string, palette: string | undefined): ThemeVars => {
  const required = (name: string): string => {
    const value = read(name).trim()
    if (value === '') throw new Error(`OpenBridge connector token ${name} is not set`)
    return value
  }
  const mediumColors = mediumColorsFromCss(required, palette)
  return {
    pipeOutlineColor: required('--automation-connector-on-border-color'),
    pipeFillColor: required('--automation-connector-on-background-color'),
    pipeOutlineInverted: required('--automation-connector-no-flow-border-color'),
    pipeFillInverted: required('--automation-connector-no-flow-background-color'),
    genericBorder: mediumColors.Teal.border,
    genericBackground: mediumColors.Teal.background,
    enhancedBorder: required('--automation-medium-enhanced-border'),
    enhancedBackground: required('--automation-medium-enhanced-background'),
    runningBorder: required('--automation-medium-running-border'),
    runningBackground: required('--automation-medium-running-background'),
    pipeDirectionHalo: required('--border-silhouette-color'),
    mediumColors,
  }
}
