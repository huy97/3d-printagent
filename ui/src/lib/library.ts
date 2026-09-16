import type { LibraryFile } from '@/lib/api'

export function isUnsliced(file: LibraryFile) {
  return (file.format === '3mf' && file.meta.sliced === false) || file.format === 'model'
}

/** Bản in được sinh ra từ một file, lần qua cả bản sắp khay hay tách vật thể ở giữa; mới nhất đứng đầu. */
export function slicedDescendants(files: LibraryFile[], id: string) {
  const found: LibraryFile[] = []
  const seen = new Set([id])
  const queue = [id]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const item of files) {
      if (item.sourceId !== parent || seen.has(item.id)) continue
      seen.add(item.id)
      if (isUnsliced(item)) queue.push(item.id)
      else found.push(item)
    }
  }
  return found.sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt))
}

/** File người dùng tự đưa vào, lần ngược qua các bản sinh ra từ nó. */
export function rootOf(files: LibraryFile[], file: LibraryFile) {
  let current = file
  const seen = new Set([file.id])
  while (current.sourceId) {
    const parent = files.find((item) => item.id === current.sourceId)
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    current = parent
  }
  return current
}
