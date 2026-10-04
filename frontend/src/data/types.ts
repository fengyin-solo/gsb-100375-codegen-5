/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 雨量资料交接：字段冲突裁决方向，站点原值或交换文件二选一。 */
export type HandoverResolution = 'station' | 'exchange'

/** 交接批次里的一行对账记录，观测人、校核人、班次是行级凭证。 */
export type HandoverRow = {
  rowKey: string
  recordId: number | null
  记录编号: string
  站点编号: string
  观测时段: string
  historical: boolean
  missingAtStation: boolean
  station: { 时段雨量: number | null; 日累计雨量: number | null }
  exchange: { 时段雨量: number; 日累计雨量: number }
  观测人: string
  校核人: string
  班次: string
  diffs: string[]
  resolutions: Record<string, HandoverResolution>
}

/** 交接批次：同一交换号只落一个入档版本。 */
export type HandoverBatch = {
  exchangeNo: string
  status: '对账中' | '已入档'
  createdAt: string
  archivedAt: string | null
  version: number
  coverageConfirmed: boolean
  rows: HandoverRow[]
}
