export interface Bookmark {
  readonly id: string
  readonly content: string
}

export type OnBookmarksChanged = () => void

export interface BookmarkStore {
  readonly list: () => ReadonlyArray<Bookmark>
  readonly add: (content: string) => Bookmark
  readonly update: (id: string, content: string) => Bookmark | undefined
  readonly remove: (id: string) => boolean
  readonly restore: (bookmarks: ReadonlyArray<Bookmark>) => void
}

export const createBookmarkStore = (onChanged?: OnBookmarksChanged): BookmarkStore => {
  const bookmarks: Bookmark[] = []
  return {
    list: () => bookmarks.slice(),
    add: (content) => {
      const bookmark = { id: crypto.randomUUID(), content }
      bookmarks.unshift(bookmark)
      onChanged?.()
      return bookmark
    },
    update: (id, content) => {
      const index = bookmarks.findIndex(bookmark => bookmark.id === id)
      if (index < 0) return undefined
      const bookmark = { id, content }
      bookmarks[index] = bookmark
      onChanged?.()
      return bookmark
    },
    remove: (id) => {
      const index = bookmarks.findIndex(bookmark => bookmark.id === id)
      if (index < 0) return false
      bookmarks.splice(index, 1)
      onChanged?.()
      return true
    },
    restore: (entries) => {
      bookmarks.length = 0
      bookmarks.push(...entries.map(bookmark => ({ ...bookmark })))
    },
  }
}
