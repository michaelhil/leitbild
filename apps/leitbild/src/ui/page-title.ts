// Browser tab titles for the Workspace shell (plan v2 §13 H3): the brand is
// "Leitbild.ai" in marks and titles; prose keeps "Leitbild".

export const BRAND_TITLE = 'Leitbild.ai'

/** "<subject> · Leitbild.ai", or the brand alone while nothing is known yet. */
export const pageTitle = (subject?: string | null): string => {
  const text = subject?.trim()
  return text ? `${text} · ${BRAND_TITLE}` : BRAND_TITLE
}

export interface WorkspaceTitleParts {
  /** The Workspace's header label (never a raw id), or null while it loads. */
  readonly workspace: string | null
  /** The open Run's title (openSubjectTitle), if a Run or Planning is shown. */
  readonly run?: string | null
  /** The open conversation's title, if one is shown without a Run. */
  readonly room?: string | null
}

/**
 * What the open Run or Planning is called in the tab: the Run; beside it, while
 * its plans show, the open plan (or "Plans" for the Library) and then the Run;
 * Planning without a Run by its plan, else "Planning".
 */
export const openSubjectTitle = (open: {
  readonly runSelected: boolean
  /** The selected Run's title; null without a Run or while the catalogue does not list it. */
  readonly run: string | null
  /** Whether Planning shows. */
  readonly planning: boolean
  /** The open plan's title, when a listed plan is open. */
  readonly plan: string | null
}): string | null => {
  if (!open.planning) return open.run
  if (!open.runSelected) return open.plan ?? 'Planning'
  const plans = open.plan ?? 'Plans'
  return open.run === null ? plans : `${plans} · ${open.run}`
}

/** The open Run, else the open conversation, else the Workspace names the tab. */
export const workspacePageTitle = (parts: WorkspaceTitleParts): string =>
  pageTitle(parts.run || parts.room || parts.workspace)

/** "(3) PWR 4-loop · Leitbild.ai": unread direct messages lead the tab title, so a hidden tab shows them. */
export const withUnreadCount = (title: string, unread: number): string => unread > 0 ? `(${unread}) ${title}` : title
