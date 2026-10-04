import { claimExchangeNo, getSession, ledgerHas, listSessions, removeSession, saveSession } from '@/data/handover-store'
import { listRows, saveRows } from '@/data/local-store'
import type {
  FieldDiff,
  HandoverDiffLine,
  HandoverSession,
  ParsedExchangeFile,
} from '@/data/handover-types'
import type { EntryRow } from '@/data/types'

// 雨量资料交接：站点原值与交换文件按「站点编号 + 观测时段」配对。
const RAINFALL_KEY = 'rainfall'
const COMPILATION_KEY = 'compilation'
const MATCH_FIELDS = ['站点编号', '观测时段'] as const
// 参与逐字段对账的业务字段；观测人、校核人、班次随入档结果逐行落库，是行级凭证。
const VALUE_FIELDS = ['时段雨量', '日累计雨量', '降雨强度', '观测人', '校核人', '班次'] as const
// 值班员预览时重点核对的两项：时段雨量、日累计雨量
const PREVIEW_FIELDS = ['时段雨量', '日累计雨量'] as const
// 站点侧已通过（已归档）的记录视为历史观测时段，对账只读兼容，不允许覆盖。
const HISTORY_STATUS = '已通过'

// 内置一份交换文件样例：既有一致行、冲突行、新增行，也覆盖一个历史只读时段，便于演示完整对账。
const SAMPLE_EXCHANGE_CSV = `交换号,EXCH-20260903-02
来文单位,上游中心站
站点编号,观测时段,时段雨量,日累计雨量,降雨强度,观测人,校核人,班次
60101100,2026-09-01 08:00-20:00,12.6,18.8,中雨,李建国,王慧,白班
60101100,2026-09-02 08:00-20:00,5.6,5.6,小雨,李建国,王慧,白班
60101100,2026-09-02 20:00-2026-09-03 08:00,3.1,8.7,小雨,赵敏,王慧,夜班
60101250,2026-09-02 08:00-20:00,31.4,41.5,大雨,陈涛,周敏,白班
60101250,2026-09-03 08:00-20:00,0.0,0.0,无雨,陈涛,周敏,白班
60101380,2026-09-03 08:00-20:00,47.2,53.0,暴雨,孙立,周敏,白班`

export function sampleExchangeCsv(): string {
  return SAMPLE_EXCHANGE_CSV
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function compactDate(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

function toNumber(value: string): number | null {
  if (value.trim() === '') {
    return null
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function coverageKey(stationNo: string, period: string): string {
  return `${stationNo}@${period}`
}

// 简单 CSV 解析：支持引号包裹与逗号转义，交换文件前两行可选「交换号/来文单位」元信息。
function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else if (ch === '"') {
        quoted = false
      } else {
        current += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      cells.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current.trim())
  return cells
}

export function parseExchangeFile(content: string, fallbackExchangeNo = ''): ParsedExchangeFile {
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '')
  const result: ParsedExchangeFile = { exchangeNo: fallbackExchangeNo, source: '', rows: [], badLines: [] }
  let headers: string[] | null = null

  for (const line of lines) {
    const cells = splitCsvLine(line)
    if (cells[0] === '交换号') {
      result.exchangeNo = cells[1] ?? fallbackExchangeNo
      continue
    }
    if (cells[0] === '来文单位') {
      result.source = cells[1] ?? ''
      continue
    }
    if (cells[0] === '站点编号') {
      headers = cells
      continue
    }
    if (!headers) {
      result.badLines.push(line)
      continue
    }
    const row: Record<string, string> = {}
    headers.forEach((header, index) => {
      if (header) {
        row[header] = cells[index] ?? ''
      }
    })
    if (!row['站点编号'] || !row['观测时段']) {
      result.badLines.push(line)
      continue
    }
    result.rows.push(row)
  }
  if (!result.exchangeNo) {
    result.exchangeNo = `EXCH-${compactDate()}-${String(listSessions().length + 1).padStart(2, '0')}`
  }
  return result
}

function buildFieldDiffs(station: EntryRow | undefined, exchange: Record<string, string> | undefined): FieldDiff[] {
  return VALUE_FIELDS.map((field) => {
    const stationValue = station ? String(station[field] ?? '') : ''
    const exchangeValue = exchange?.[field] ?? ''
    let verdict: FieldDiff['verdict']
    if (station && exchange) {
      verdict = stationValue.trim() === exchangeValue.trim() ? 'same' : 'conflict'
    } else if (station) {
      verdict = 'station-only'
    } else {
      verdict = 'exchange-only'
    }
    return { field, stationValue, exchangeValue, verdict }
  })
}

// 把站点原值和交换文件逐行配对，生成差异行；历史已归档时段直接标只读。
function buildDiffLines(exchangeRows: Record<string, string>[]): HandoverDiffLine[] {
  const stationRows = listRows(RAINFALL_KEY)
  const lines: HandoverDiffLine[] = []
  const matchedStationIds = new Set<number>()

  for (const payload of exchangeRows) {
    const stationNo = payload['站点编号']
    const period = payload['观测时段']
    const station = stationRows.find(
      (row) => String(row['站点编号']) === stationNo && String(row['观测时段']) === period,
    )
    if (station) {
      matchedStationIds.add(Number(station.id))
    }
    const readonly = station ? String(station.status) === HISTORY_STATUS : false
    const fields = buildFieldDiffs(station, payload)
    const hasConflict = fields.some((item) => item.verdict === 'conflict')
    lines.push({
      stationNo,
      period,
      presence: station ? 'both' : 'exchange-only',
      fields,
      resolutions: {},
      stationRowId: station ? Number(station.id) : null,
      exchangePayload: payload,
      readonly,
      // 历史只读行、完全一致行、交换新增行都不需要人工裁定；只有冲突行等值班员拿主意。
      resolved: readonly || !hasConflict,
    })
  }

  // 站点有、交换文件没有的记录列入差异，作为「出站」方向；不产生覆盖，默认无需裁定。
  for (const station of stationRows) {
    if (matchedStationIds.has(Number(station.id))) {
      continue
    }
    const readonly = String(station.status) === HISTORY_STATUS
    lines.push({
      stationNo: String(station['站点编号']),
      period: String(station['观测时段']),
      presence: 'station-only',
      fields: buildFieldDiffs(station, undefined),
      resolutions: {},
      stationRowId: Number(station.id),
      exchangePayload: {},
      readonly,
      resolved: true,
    })
  }

  return lines
}

export type HandoverMutation = { ok: boolean; message: string; session?: HandoverSession }

export function createHandover(
  exchangeNoInput: string,
  source: string,
  exchangeRows: Record<string, string>[],
): HandoverMutation {
  const exchangeNo = exchangeNoInput.trim()
  if (!exchangeNo) {
    return { ok: false, message: '交换号不能为空' }
  }
  if (listSessions().some((item) => item.exchangeNo === exchangeNo)) {
    return { ok: false, message: `交换号 ${exchangeNo} 的对账单已存在，可在下方继续，不能重复建单` }
  }
  if (ledgerHas(exchangeNo)) {
    return { ok: false, message: `交换号 ${exchangeNo} 已确认入档，同一交换号只保留一个版本` }
  }
  if (!exchangeRows.length) {
    return { ok: false, message: '交换文件里没有可对账的雨量行（需含站点编号、观测时段）' }
  }
  const diffLines = buildDiffLines(exchangeRows)
  // 默认覆盖交换文件带来的全部「站点 + 时段」；站点独有行默认不在本次覆盖范围内。
  const coveredKeys = diffLines
    .filter((line) => line.presence === 'both' || line.presence === 'exchange-only')
    .map((line) => coverageKey(line.stationNo, line.period))
  const session: HandoverSession = {
    id: `HD-${compactDate()}-${String(Date.now()).slice(-6)}`,
    exchangeNo,
    exchangeSource: source.trim(),
    createdAt: nowText(),
    updatedAt: nowText(),
    status: 'draft',
    diffLines,
    coveredKeys,
    coverageConfirmed: false,
    cursor: 0,
    dutyObserver: '',
    dutyChecker: '',
    dutyShift: '',
    archivedAt: null,
    archivedVersion: null,
    compilationResultId: null,
  }
  session.cursor = continueCursor(session)
  saveSession(session)
  return { ok: true, message: `已生成对账草稿 ${session.id}，共 ${diffLines.length} 行`, session }
}

// 中断后继续：定位第一个未处理差异行；都处理完返回 -1。
export function continueCursor(session: HandoverSession): number {
  const index = session.diffLines.findIndex((line) => !line.readonly && !line.resolved)
  return index < 0 ? -1 : index
}

function mutate(sessionId: string, apply: (session: HandoverSession) => string | null): HandoverMutation {
  const session = getSession(sessionId)
  if (!session) {
    return { ok: false, message: '没有找到这份交接对账单' }
  }
  if (session.status === 'archived') {
    return { ok: false, message: '该交换号已确认入档，版本已冻结，不能再改', session }
  }
  const error = apply(session)
  if (error) {
    return { ok: false, message: error, session }
  }
  session.cursor = continueCursor(session)
  session.updatedAt = nowText()
  saveSession(session)
  return { ok: true, message: '', session }
}

// 字段冲突裁定：采纳站点原值还是交换文件值。
export function resolveField(
  sessionId: string,
  lineIndex: number,
  field: string,
  choice: 'station' | 'exchange',
): HandoverMutation {
  return mutate(sessionId, (session) => {
    const line = session.diffLines[lineIndex]
    if (!line) {
      return '差异行不存在'
    }
    if (line.readonly) {
      return '历史观测时段只读兼容，不能改采纳结果'
    }
    const target = line.fields.find((item) => item.field === field)
    if (!target || target.verdict !== 'conflict') {
      return '该字段没有冲突，不需要裁定'
    }
    line.resolutions[field] = choice
    line.resolved = line.fields.every((item) => item.verdict !== 'conflict' || line.resolutions[item.field])
    return null
  })
}

// 批量给剩余冲突一个统一去向（「全部采纳站点原值 / 全部采纳交换文件」）。
export function resolveRemaining(sessionId: string, choice: 'station' | 'exchange'): HandoverMutation {
  return mutate(sessionId, (session) => {
    let count = 0
    for (const line of session.diffLines) {
      if (line.readonly) {
        continue
      }
      for (const item of line.fields) {
        if (item.verdict === 'conflict' && !line.resolutions[item.field]) {
          line.resolutions[item.field] = choice
          count += 1
        }
      }
      line.resolved = line.fields.every((item) => item.verdict !== 'conflict' || line.resolutions[item.field])
    }
    return count === 0 ? '没有待裁定的冲突字段了' : null
  })
}

export function setLineCovered(sessionId: string, key: string, covered: boolean): HandoverMutation {
  return mutate(sessionId, (session) => {
    if (!session.diffLines.some((line) => coverageKey(line.stationNo, line.period) === key)) {
      return '覆盖范围里没有这一行'
    }
    const set = new Set(session.coveredKeys)
    if (covered) {
      set.add(key)
    } else {
      set.delete(key)
    }
    session.coveredKeys = [...set]
    session.coverageConfirmed = false
    return null
  })
}

export function confirmCoverage(sessionId: string, confirmed: boolean): HandoverMutation {
  return mutate(sessionId, (session) => {
    if (confirmed && session.coveredKeys.length === 0) {
      return '至少要确认一个「站点 + 观测时段」的覆盖范围'
    }
    session.coverageConfirmed = confirmed
    return null
  })
}

export function setDutyCredentials(
  sessionId: string,
  credentials: { observer: string; checker: string; shift: string },
): HandoverMutation {
  return mutate(sessionId, (session) => {
    session.dutyObserver = credentials.observer.trim()
    session.dutyChecker = credentials.checker.trim()
    session.dutyShift = credentials.shift.trim()
    return null
  })
}

export function discardDraft(sessionId: string): HandoverMutation {
  const session = getSession(sessionId)
  if (!session) {
    return { ok: false, message: '没有找到这份交接对账单' }
  }
  if (session.status === 'archived') {
    return { ok: false, message: '已入档版本不能删除', session }
  }
  removeSession(sessionId)
  return { ok: true, message: '对账草稿已放弃' }
}

// 对账预览：重点字段（时段雨量、日累计雨量）的数值差，正值表示交换文件更大。
export function previewDelta(line: HandoverDiffLine, field: string): string {
  if (!PREVIEW_FIELDS.includes(field as (typeof PREVIEW_FIELDS)[number])) {
    return ''
  }
  const target = line.fields.find((item) => item.field === field)
  if (!target || target.verdict !== 'conflict') {
    return ''
  }
  const station = toNumber(target.stationValue)
  const exchange = toNumber(target.exchangeValue)
  if (station === null || exchange === null) {
    return '非数值差异'
  }
  const delta = exchange - station
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} mm`
}

export function diffSummary(session: HandoverSession) {
  return {
    total: session.diffLines.length,
    // 历史只读行的差异只展示不可裁定，不计入待处理冲突。
    conflicts: session.diffLines.filter(
      (line) => !line.readonly && line.fields.some((item) => item.verdict === 'conflict'),
    ).length,
    incoming: session.diffLines.filter((line) => line.presence === 'exchange-only').length,
    outgoing: session.diffLines.filter((line) => line.presence === 'station-only').length,
    readonly: session.diffLines.filter((line) => line.readonly).length,
    pending: session.diffLines.filter((line) => !line.readonly && !line.resolved).length,
  }
}

function adoptedValue(line: HandoverDiffLine, field: string): string {
  const target = line.fields.find((item) => item.field === field)
  if (!target) {
    return ''
  }
  if (target.verdict === 'conflict') {
    return line.resolutions[field] === 'station' ? target.stationValue : target.exchangeValue
  }
  if (target.verdict === 'exchange-only') {
    return target.exchangeValue
  }
  return target.stationValue
}

// 清单/入档共用：观测人、校核人、班次缺失时用本次值班登记补齐，保证行级凭证完整。
function listValueWithDuty(line: HandoverDiffLine, session: HandoverSession, field: string): string {
  const value = adoptedValue(line, field)
  if (value.trim() !== '' || !['观测人', '校核人', '班次'].includes(field)) {
    return value
  }
  return field === '观测人' ? session.dutyObserver : field === '校核人' ? session.dutyChecker : session.dutyShift
}

// 双向交换清单：出站（站点提供给对方）、入站（交换来文落本站）、历史只读逐行可追溯。
export function buildExchangeListCsv(session: HandoverSession): string {
  const meta = [
    ['交换号', session.exchangeNo],
    ['来文单位', session.exchangeSource || '—'],
    ['生成时间', nowText()],
    [],
  ]
  const header = [
    '方向',
    '站点编号',
    '观测时段',
    '时段雨量',
    '日累计雨量',
    '降雨强度',
    '观测人',
    '校核人',
    '班次',
    '对账结论',
  ]
  const directionOf = (line: HandoverDiffLine): string => {
    if (line.readonly) {
      return '历史只读'
    }
    if (line.presence === 'station-only') {
      return '出站（站点提供）'
    }
    if (line.presence === 'exchange-only') {
      return '入站（交换来文）'
    }
    return '双向核对'
  }
  const rows = session.diffLines.map((line) => [
    directionOf(line),
    line.stationNo,
    line.period,
    listValueWithDuty(line, session, '时段雨量'),
    listValueWithDuty(line, session, '日累计雨量'),
    listValueWithDuty(line, session, '降雨强度'),
    listValueWithDuty(line, session, '观测人'),
    listValueWithDuty(line, session, '校核人'),
    listValueWithDuty(line, session, '班次'),
    line.readonly ? '历史时段只读，维持站点原值' : line.resolved ? '已对账' : '待裁定',
  ])
  return [
    ...meta.map((cells) => cells.join(',')),
    header.join(','),
    ...rows.map((cells) => cells.map((cell) => String(cell).replace(/"/g, '""')).join(',')),
  ].join('\n')
}

export function downloadExchangeList(sessionId: string): HandoverMutation {
  const session = getSession(sessionId)
  if (!session) {
    return { ok: false, message: '没有找到这份交接对账单' }
  }
  const blob = new Blob([`﻿${buildExchangeListCsv(session)}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `双向交换清单-${session.exchangeNo}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return { ok: true, message: '双向交换清单已生成并开始下载' }
}

function buildArchivePayload(line: HandoverDiffLine, session: HandoverSession): Record<string, string> {
  const payload: Record<string, string> = {}
  for (const field of VALUE_FIELDS) {
    payload[field] = listValueWithDuty(line, session, field)
  }
  return payload
}

export type ArchiveResult = HandoverMutation & { written?: number }

// 确认入档：同一交换号并发确认只落一个版本（台账抢占）；入档后整编页同步补待核对成果。
export function archiveHandover(sessionId: string): ArchiveResult {
  const session = getSession(sessionId)
  if (!session) {
    return { ok: false, message: '没有找到这份交接对账单' }
  }
  if (session.status === 'archived') {
    return {
      ok: false,
      message: `交换号 ${session.exchangeNo} 已有入档版本（版本 v${session.archivedVersion ?? 1}），不能重复确认`,
      session,
    }
  }
  const pending = continueCursor(session)
  if (pending >= 0) {
    return { ok: false, message: `第 ${pending + 1} 行还有字段冲突未裁定，请先对账完成`, session }
  }
  if (!session.coverageConfirmed) {
    return { ok: false, message: '请先确认覆盖范围，再确认入档', session }
  }
  if (!session.dutyObserver || !session.dutyChecker || !session.dutyShift) {
    return { ok: false, message: '请登记本次值班的观测人、校核人和班次', session }
  }

  // 先抢占交换号：同机多标签页并发确认时，抢不到的一方直接终止，不落第二个版本。
  const claimed = claimExchangeNo({
    exchangeNo: session.exchangeNo,
    sessionId: session.id,
    version: 1,
    archivedAt: nowText(),
  })
  if (!claimed) {
    return { ok: false, message: `交换号 ${session.exchangeNo} 已被另一个确认动作占用，本次只保留一个版本`, session }
  }

  const rainfallRows = listRows(RAINFALL_KEY)
  const covered = new Set(session.coveredKeys)
  let written = 0
  const writtenStations = new Set<string>()
  const writtenYears = new Set<string>()

  for (const line of session.diffLines) {
    const key = coverageKey(line.stationNo, line.period)
    if (!covered.has(key)) {
      continue
    }
    if (line.readonly) {
      // 历史观测时段只读兼容：在覆盖范围内也不改原值。
      continue
    }
    const payload = buildArchivePayload(line, session)
    const existingIndex = line.stationRowId
      ? rainfallRows.findIndex((row) => Number(row.id) === line.stationRowId)
      : -1
    if (existingIndex >= 0) {
      rainfallRows[existingIndex] = {
        ...rainfallRows[existingIndex],
        ...payload,
        status: HISTORY_STATUS,
        pending: false,
        abnormal: false,
        记录状态: '已交接入档',
      }
      written += 1
    } else if (line.presence === 'exchange-only') {
      const recordNo = line.exchangePayload['记录编号'] || `RAIN-${compactDate()}-${String(nextId(rainfallRows)).padStart(4, '0')}`
      rainfallRows.push({
        id: nextId(rainfallRows),
        status: HISTORY_STATUS,
        pending: false,
        abnormal: false,
        记录编号: recordNo,
        站点编号: line.stationNo,
        观测时段: line.period,
        ...payload,
        记录状态: '交换新增入档',
      })
      written += 1
    }
    writtenStations.add(line.stationNo)
    const yearMatch = line.period.match(/(\d{4})/)
    if (yearMatch) {
      writtenYears.add(yearMatch[1])
    }
  }
  saveRows(RAINFALL_KEY, rainfallRows)

  // 入档完成，整编页面一并补一条「待核对」成果。
  const compilationRows = listRows(COMPILATION_KEY)
  const resultId = nextId(compilationRows)
  const year = writtenYears.size === 1 ? [...writtenYears][0] : [...writtenYears].sort().join('/')
  compilationRows.push({
    id: resultId,
    status: '待核对',
    pending: true,
    abnormal: false,
    成果编号: `CHK-${compactDate()}-${String(resultId).padStart(4, '0')}`,
    整编年份: year,
    站点编号: [...writtenStations].join('/'),
    整编类型: '雨量资料交换入档',
    原始记录数: written,
    整编人: session.dutyObserver,
    审核人: session.dutyChecker,
    来源交换号: session.exchangeNo,
    整编状态: '待核对',
  })
  saveRows(COMPILATION_KEY, compilationRows)

  session.status = 'archived'
  session.coverageConfirmed = true
  session.cursor = -1
  session.archivedAt = nowText()
  session.archivedVersion = 1
  session.compilationResultId = resultId
  session.updatedAt = session.archivedAt
  saveSession(session)

  return { ok: true, message: `交换号 ${session.exchangeNo} 已确认入档，写入 ${written} 行，整编待核对成果已生成`, session, written }
}

export function listHandovers(): HandoverSession[] {
  return [...listSessions()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export { MATCH_FIELDS, VALUE_FIELDS, HISTORY_STATUS }
