import type { HandoverBatch } from './types'

// 交接批次独立持久化：刷新或关掉再打开，对账进度还在，中断后从差异行继续。
const STORAGE_KEY = 'hydrology-monitor-station:handover-batches'

function readStorage(): HandoverBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as HandoverBatch[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

let cache: HandoverBatch[] | null = null

export function loadBatches(): HandoverBatch[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveBatches(batches: HandoverBatch[]): void {
  cache = batches
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(batches))
  }
}

// 并发确认时以存储里的最新状态为准，不用页面手里的旧快照。
export function reloadBatches(): HandoverBatch[] {
  cache = readStorage()
  return cache
}
