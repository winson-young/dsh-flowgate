/** Loaded literals are independent of subsequent disk reads and module cache reuse. */
const loaded = new Map()

export const FLOWGATE_MODULE_REVISION = '8e865caec250ed7dd9360f3d334648575d443687daee254ab0f496fcdfca3d70'

function moduleKey(url) {
  const key = new URL(url)
  key.search = ''
  key.hash = ''
  return key.href
}

export function registerModuleRevision(url, revision) {
  const key = moduleKey(url)
  const versions = loaded.get(key) ?? new Set()
  versions.add(revision)
  loaded.set(key, versions)
}

export function registeredModuleRevisions(url) {
  return [...(loaded.get(moduleKey(url)) ?? [])].sort()
}

registerModuleRevision(import.meta.url, FLOWGATE_MODULE_REVISION)
