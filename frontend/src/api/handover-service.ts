import { EXCHANGE_FILE_ROWS } from '@/data/exchange-seed'
import { loadBatches, reloadBatches, saveBatches } from '@/data/handover-store'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow, HandoverBatch, HandoverResolution, HandoverRow } from '@/data/types'

// 对账只核这两个数值字段；观测人、校核人、班次作为行级凭证随行展示，不参与差异判定。
const DIFF_FIELDS = ['时段雨量', '日累计雨量'] as const
// 观测日期早于当前超过 30 天的时段按历史资料处理：只读兼容，差异仅展示。
const HISTORICAL_DAYS = 30
// 同一交换号的入档确认在页面内也只放行一次，防止连点重复落版本。
const inflight = new Set<string>()

export type ArchiveResult = {
  ok: boolean
  already: boolean
  version: number
  message: string
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function toNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function periodDate(period: string): Date | null {
  const match = period.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!match) {
    return null
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

export function isHistoricalPeriod(period: string): boolean {
  const date = periodDate(period)
  if (!date) {
    return false
  }
  const ageMs = Date.now() - date.getTime()
  return ageMs > HISTORICAL_DAYS * 24 * 60 * 60 * 1000
}

function buildRow(exchange: (typeof EXCHANGE_FILE_ROWS)[number], stationRow: EntryRow | undefined): HandoverRow {
  const stationPeriod = stationRow ? toNumber(stationRow['时段雨量']) : null
  const stationDaily = stationRow ? toNumber(stationRow['日累计雨量']) : null
  const diffs: string[] = []
  if (stationRow) {
    if (stationPeriod === null || Math.abs(stationPeriod - exchange.时段雨量) > 1e-9) {
      diffs.push('时段雨量')
    }
    if (stationDaily === null || Math.abs(stationDaily - exchange.日累计雨量) > 1e-9) {
      diffs.push('日累计雨量')
    }
  }
  return {
    rowKey: exchange.记录编号,
    recordId: stationRow ? Number(stationRow.id) : null,
    记录编号: exchange.记录编号,
    站点编号: exchange.站点编号,
    观测时段: exchange.观测时段,
    historical: isHistoricalPeriod(exchange.观测时段),
    missingAtStation: !stationRow,
    station: { 时段雨量: stationPeriod, 日累计雨量: stationDaily },
    exchange: { 时段雨量: exchange.时段雨量, 日累计雨量: exchange.日累计雨量 },
    观测人: exchange.观测人,
    校核人: exchange.校核人,
    班次: exchange.班次,
    diffs,
    resolutions: {},
  }
}

function nextExchangeNo(batches: HandoverBatch[]): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const serial = batches.filter((item) => item.exchangeNo.includes(stamp)).length + 1
  return `EX-${stamp}-${String(serial).padStart(2, '0')}`
}

export function listBatches(): HandoverBatch[] {
  return loadBatches()
}

export function getBatch(exchangeNo: string): HandoverBatch | undefined {
  return loadBatches().find((item) => item.exchangeNo === exchangeNo)
}

/** 尚未入档的批次就是断点：页面刷新或关掉再打开，从它继续对账。 */
export function getActiveBatch(): HandoverBatch | undefined {
  return loadBatches().find((item) => item.status !== '已入档')
}

function mutateBatch(exchangeNo: string, mutate: (batch: HandoverBatch) => void): HandoverBatch | undefined {
  const batches = clone(loadBatches())
  const batch = batches.find((item) => item.exchangeNo === exchangeNo)
  if (!batch) {
    return undefined
  }
  mutate(batch)
  saveBatches(batches)
  return batch
}

/** 接收交换文件并建批对账；已有未入档批次时直接返回断点批次，不重复建批。 */
export function receiveExchangeFile(): HandoverBatch {
  const active = getActiveBatch()
  if (active) {
    return active
  }
  const stationRows = listRows('rainfall')
  const byCode = new Map(stationRows.map((row) => [String(row['记录编号']), row]))
  const batches = clone(loadBatches())
  const batch: HandoverBatch = {
    exchangeNo: nextExchangeNo(batches),
    status: '对账中',
    createdAt: new Date().toISOString(),
    archivedAt: null,
    version: 0,
    coverageConfirmed: false,
    rows: EXCHANGE_FILE_ROWS.map((row) => buildRow(row, byCode.get(row.记录编号))),
  }
  batches.push(batch)
  saveBatches(batches)
  return batch
}

export function confirmCoverage(exchangeNo: string): HandoverBatch | undefined {
  return mutateBatch(exchangeNo, (batch) => {
    if (batch.status !== '已入档') {
      batch.coverageConfirmed = true
    }
  })
}

/** 行级裁决：字段冲突时逐字段决定采纳站点原值还是交换文件，选择即落盘。 */
export function resolveField(
  exchangeNo: string,
  rowKey: string,
  field: string,
  choice: HandoverResolution,
): HandoverBatch | undefined {
  return mutateBatch(exchangeNo, (batch) => {
    if (batch.status === '已入档') {
      return
    }
    const row = batch.rows.find((item) => item.rowKey === rowKey)
    if (!row || row.historical || !row.diffs.includes(field)) {
      return
    }
    row.resolutions[field] = choice
  })
}

export type BatchProgress = {
  total: number
  diffRows: number
  resolvedRows: number
  historicalRows: number
  missingRows: number
  allResolved: boolean
}

export function rowResolved(row: HandoverRow): boolean {
  return row.diffs.every((field) => row.resolutions[field] !== undefined)
}

export function batchProgress(batch: HandoverBatch): BatchProgress {
  const actionable = batch.rows.filter((row) => !row.historical && !row.missingAtStation)
  const diffRows = actionable.filter((row) => row.diffs.length > 0)
  const resolvedRows = diffRows.filter(rowResolved)
  return {
    total: batch.rows.length,
    diffRows: diffRows.length,
    resolvedRows: resolvedRows.length,
    historicalRows: batch.rows.filter((row) => row.historical).length,
    missingRows: batch.rows.filter((row) => row.missingAtStation).length,
    allResolved: diffRows.length === resolvedRows.length,
  }
}

/** 裁决后生效值：一致取站点原值，冲突按行级裁决，历史行永远保留站点原值。 */
export function effectiveValue(row: HandoverRow, field: (typeof DIFF_FIELDS)[number]): number | null {
  const stationValue = row.station[field]
  if (row.historical || row.missingAtStation || !row.diffs.includes(field)) {
    return stationValue
  }
  return row.resolutions[field] === 'exchange' ? row.exchange[field] : stationValue
}

export function resolutionLabel(row: HandoverRow, field: string): string {
  if (row.historical) {
    return '历史只读'
  }
  if (row.missingAtStation) {
    return '站点缺报'
  }
  if (!row.diffs.includes(field)) {
    return '一致'
  }
  return row.resolutions[field] === 'exchange' ? '采纳交换文件' : '采纳站点原值'
}

/**
 * 确认入档：同一交换号并发确认只落一个版本。
 * 重读存储后再判状态，另一个标签页已入档时直接返回既有版本；
 * 整编页的待核对成果按成果编号去重，重复确认不会补第二笔。
 */
export function confirmArchive(exchangeNo: string, operator: string): ArchiveResult {
  if (inflight.has(exchangeNo)) {
    return { ok: false, already: false, version: 0, message: `交换号 ${exchangeNo} 正在入档，请勿重复提交` }
  }
  inflight.add(exchangeNo)
  try {
    const batches = clone(reloadBatches())
    const batch = batches.find((item) => item.exchangeNo === exchangeNo)
    if (!batch) {
      return { ok: false, already: false, version: 0, message: `没有找到交换号 ${exchangeNo} 的交接批次` }
    }
    if (batch.status === '已入档') {
      return {
        ok: true,
        already: true,
        version: batch.version,
        message: `交换号 ${exchangeNo} 已入档（版本 V${batch.version}），并发确认只保留一个版本`,
      }
    }
    if (!batch.coverageConfirmed) {
      return { ok: false, already: false, version: 0, message: '请先确认本次交接的覆盖范围' }
    }
    const pendingRows = batch.rows.filter(
      (row) => !row.historical && !row.missingAtStation && row.diffs.length > 0 && !rowResolved(row),
    )
    if (pendingRows.length > 0) {
      return { ok: false, already: false, version: 0, message: `还有 ${pendingRows.length} 行差异未裁决，先从差异行继续处理` }
    }

    // 应用裁决结果回写雨量记录，历史时段只读不动。
    const rainRows = clone(listRows('rainfall'))
    for (const row of batch.rows) {
      if (row.historical || row.recordId === null) {
        continue
      }
      const target = rainRows.find((item) => Number(item.id) === row.recordId)
      if (!target) {
        continue
      }
      for (const field of DIFF_FIELDS) {
        const value = effectiveValue(row, field)
        if (value !== null) {
          target[field] = value
        }
      }
    }
    saveRows('rainfall', rainRows)

    // 整编页一并补上待核对成果，按成果编号幂等。
    const resultCode = `HB-${exchangeNo}`
    const compRows = clone(listRows('compilation'))
    if (!compRows.some((row) => String(row['成果编号']) === resultCode)) {
      const stations = [...new Set(batch.rows.map((row) => row.站点编号))].join('、')
      const year = periodDate(batch.rows.find((row) => !row.historical)?.观测时段 ?? '')?.getFullYear() ?? new Date().getFullYear()
      const nextId = compRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
      compRows.push({
        id: nextId,
        status: '待审核',
        pending: true,
        abnormal: false,
        成果编号: resultCode,
        整编年份: `${year}年`,
        站点编号: stations,
        整编类型: '雨量资料交接',
        原始记录数: batch.rows.length,
        整编人: operator,
        审核人: '待核对',
        整编状态: '待核对',
      })
      saveRows('compilation', compRows)
    }

    batch.status = '已入档'
    batch.version = 1
    batch.archivedAt = new Date().toISOString()
    saveBatches(batches)
    return {
      ok: true,
      already: false,
      version: batch.version,
      message: `交换号 ${exchangeNo} 已入档（版本 V${batch.version}），整编页已补待核对成果 ${resultCode}`,
    }
  } finally {
    inflight.delete(exchangeNo)
  }
}

/** 双向交换清单：上行站点报送 + 下行入档回执，行级凭证随清单下载。 */
export function buildManifest(batch: HandoverBatch): string {
  const lines: string[] = [
    `交换号,${batch.exchangeNo}`,
    `批次状态,${batch.status}${batch.version > 0 ? `（版本 V${batch.version}）` : ''}`,
    `生成时间,${new Date().toLocaleString('zh-CN')}`,
    '',
    '方向,上行·站点报送清单（站点→整编）',
    '记录编号,站点编号,观测时段,站点时段雨量(mm),站点日累计雨量(mm),观测人,校核人,班次,行属性',
  ]
  for (const row of batch.rows) {
    const attr = row.historical ? '历史只读' : row.missingAtStation ? '站点缺报' : row.diffs.length > 0 ? '有差异' : '一致'
    lines.push(
      [
        row.记录编号,
        row.站点编号,
        row.观测时段,
        row.station.时段雨量 ?? '缺报',
        row.station.日累计雨量 ?? '缺报',
        row.观测人,
        row.校核人,
        row.班次,
        attr,
      ].join(','),
    )
  }
  lines.push('', '方向,下行·入档回执清单（整编→站点）')
  lines.push('记录编号,站点编号,观测时段,入档时段雨量(mm),入档日累计雨量(mm),时段雨量来源,日累计来源,回执说明')
  for (const row of batch.rows) {
    const note = row.historical
      ? '历史时段只读兼容，不随本次入档修改'
      : row.missingAtStation
        ? '站点缺报，本次不入档'
        : '按对账裁决入档'
    lines.push(
      [
        row.记录编号,
        row.站点编号,
        row.观测时段,
        effectiveValue(row, '时段雨量') ?? '缺报',
        effectiveValue(row, '日累计雨量') ?? '缺报',
        resolutionLabel(row, '时段雨量'),
        resolutionLabel(row, '日累计雨量'),
        note,
      ].join(','),
    )
  }
  return `﻿${lines.join('\n')}`
}

export function downloadManifest(batch: HandoverBatch): void {
  const blob = new Blob([buildManifest(batch)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `雨量交接-双向交换清单-${batch.exchangeNo}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
