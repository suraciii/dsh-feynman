/**
 * Bounded in-memory store for fetched document text.
 *
 * `feynman_fetch_content` writes the full text of a fetched source here and
 * returns its id, so `feynman_search_content` can page or search it without
 * re-downloading. Entries are evicted oldest-first once either bound is hit;
 * the on-disk copy under `.feynman/fetch/` is the durable artifact.
 */
export function createContentStore({ maxEntries = 128, maxChars = 8 * 1024 * 1024 } = {}) {
  const entries = new Map()
  let totalChars = 0

  const drop = (id) => {
    const entry = entries.get(id)
    if (!entry) return
    totalChars -= entry.text.length
    entries.delete(id)
  }

  return {
    put(entry) {
      if (!entry?.id || typeof entry.text !== 'string') throw new TypeError('A stored fetch needs an id and text')
      drop(entry.id)
      entries.set(entry.id, entry)
      totalChars += entry.text.length
      while (entries.size > maxEntries || (totalChars > maxChars && entries.size > 1)) {
        drop(entries.keys().next().value)
      }
      return entry
    },
    get(id) {
      return entries.get(id)
    },
    latest() {
      const keys = [...entries.keys()]
      return keys.length ? entries.get(keys.at(-1)) : undefined
    },
    delete(id) {
      drop(id)
    },
    get size() {
      return entries.size
    },
    get chars() {
      return totalChars
    },
    clear() {
      entries.clear()
      totalChars = 0
    },
  }
}

/** Characters returned inline when a caller does not set an explicit limit. */
export const DEFAULT_WINDOW_CHARS = 16000
/** Hard cap for one `feynman_search_content` window. */
export const MAX_WINDOW_CHARS = 60000
