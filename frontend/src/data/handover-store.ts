import type { HandoverLedgerEntry, HandoverSession } from './handover-types'

// 交接对账数据单独存一份 localStorage，和业务登记表（entries）互不干扰。
const SESSION_KEY = 'hydrology-monitor-station:rainfall-handover'
const LEDGER_KEY = 'hydrology-monitor-station:rainfall-handover-ledger'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

let sessionCache: HandoverSession[] | null = null

export function listSessions(): HandoverSession[] {
  if (sessionCache === null) {
    sessionCache = readJson<HandoverSession[]>(SESSION_KEY, [])
  }
  return sessionCache
}

export function getSession(id: string): HandoverSession | null {
  return listSessions().find((item) => item.id === id) ?? null
}

export function saveSession(session: HandoverSession): void {
  const rows = listSessions()
  const index = rows.findIndex((item) => item.id === session.id)
  const next = index < 0 ? [...rows, clone(session)] : rows.map((item, i) => (i === index ? clone(session) : item))
  sessionCache = next
  writeJson(SESSION_KEY, next)
}

export function removeSession(id: string): void {
  sessionCache = listSessions().filter((item) => item.id !== id)
  writeJson(SESSION_KEY, sessionCache)
}

// 交换号台账：并发确认时靠它判重，保证同一交换号只落一个版本。
export function listLedger(): HandoverLedgerEntry[] {
  return readJson<HandoverLedgerEntry[]>(LEDGER_KEY, [])
}

export function ledgerHas(exchangeNo: string): boolean {
  return listLedger().some((item) => item.exchangeNo === exchangeNo)
}

// 原子地「占用」一个交换号：先检查再登记，中途被别的标签页抢先就返回 false。
export function claimExchangeNo(entry: HandoverLedgerEntry): boolean {
  if (ledgerHas(entry.exchangeNo)) {
    return false
  }
  const next = [...listLedger(), entry]
  writeJson(LEDGER_KEY, next)
  // 回读校验：同机多个标签页并发写时，只有真正写进去的那一方算成功。
  return listLedger().some((item) => item.exchangeNo === entry.exchangeNo && item.sessionId === entry.sessionId)
}

export function handoverStorageKeys(): { session: string; ledger: string } {
  return { session: SESSION_KEY, ledger: LEDGER_KEY }
}
