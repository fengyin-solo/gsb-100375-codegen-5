/** 雨量资料「先对账后入档」领域类型。纯前端实现，换回后端时这些结构对应交接单接口。 */

// 差异行的双方在场情况：仅站点有 / 仅交换文件有 / 两边都有 / 历史只读时段
export type DiffPresence = 'station-only' | 'exchange-only' | 'both' | 'history-readonly'

// 单个字段的对账结论
export type FieldVerdict = 'same' | 'conflict' | 'station-only' | 'exchange-only'

export type FieldDiff = {
  field: string
  stationValue: string
  exchangeValue: string
  verdict: FieldVerdict
}

// 差异行（对账明细的一行）。观测人、校核人、班次随入档结果逐行写入，是行级凭证。
export type HandoverDiffLine = {
  stationNo: string
  period: string
  presence: DiffPresence
  fields: FieldDiff[]
  // 冲突字段由值班员逐字段裁定：采纳站点原值还是交换文件值
  resolutions: Record<string, 'station' | 'exchange'>
  // 站点侧已有记录的内部 id，入档时按它 upsert
  stationRowId: number | null
  // 交换文件带来的行载荷（字段名 -> 值）
  exchangePayload: Record<string, string>
  // 历史观测时段（站点侧已通过归档的时段）只读兼容：只展示差异，不覆盖
  readonly: boolean
  resolved: boolean
}

export type HandoverStatus = 'draft' | 'archived'

// 一次资料交接会话（一个交换号一条；入档后冻结为唯一版本）
export type HandoverSession = {
  id: string
  exchangeNo: string
  exchangeSource: string
  createdAt: string
  updatedAt: string
  status: HandoverStatus
  diffLines: HandoverDiffLine[]
  // 覆盖范围确认：勾选入档的「站点 + 观测日」组合
  coveredKeys: string[]
  coverageConfirmed: boolean
  // 对账进度：中断后从第一个未处理差异行继续
  cursor: number
  // 入档时登记的班次级凭证
  dutyObserver: string
  dutyChecker: string
  dutyShift: string
  archivedAt: string | null
  archivedVersion: number | null
  // 入档后回写整编页的待核对成果 id
  compilationResultId: number | null
}

// 交换号台账：同一交换号并发确认只允许落一个版本
export type HandoverLedgerEntry = {
  exchangeNo: string
  sessionId: string
  version: number
  archivedAt: string
}

export type ParsedExchangeFile = {
  exchangeNo: string
  source: string
  rows: Record<string, string>[]
  badLines: string[]
}
