/* 冒烟脚本：node 直接跑，验证先对账后入档的完整业务链路（非单测框架，断言失败即退出码 1）。 */
import { build as esbuild } from 'esbuild'
import { writeFileSync, mkdirSync } from 'node:fs'

// ---- 最小浏览器环境桩：localStorage 用内存 Map 实现 ----
const memory = new Map()
const localStorageStub = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
}
globalThis.window = { localStorage: localStorageStub }
globalThis.localStorage = localStorageStub

const testCode = `
import {
  parseExchangeFile, createHandover, resolveField, resolveRemaining, continueCursor,
  setDutyCredentials, confirmCoverage, archiveHandover, diffSummary, listHandovers,
  sampleExchangeCsv, buildExchangeListCsv,
} from '@/api/handover-service'
import { saveSession, getSession, listLedger } from '@/data/handover-store'
import { listRows, resetRows } from '@/data/local-store'

let failures = 0
function check(name, cond, extra) {
  if (cond) { console.log('  PASS', name) }
  else { failures += 1; console.log('  FAIL', name, extra ?? '') }
}

// 1. 解析样例交换文件
const parsed = parseExchangeFile(sampleExchangeCsv())
check('解析出 6 行交换记录', parsed.rows.length === 6, parsed.rows.length)
check('交换号来自文件元信息', parsed.exchangeNo === 'EXCH-20260903-02', parsed.exchangeNo)
check('来文单位解析', parsed.source === '上游中心站', parsed.source)

// 2. 建对账单
const created = createHandover(parsed.exchangeNo, parsed.source, parsed.rows)
check('对账单创建成功', created.ok, created.message)
const sid = created.session.id
let s = getSession(sid)
const sum0 = diffSummary(s)
check('差异共 6 行', sum0.total === 6, JSON.stringify(sum0))
check('3 行存在待裁定冲突（只读行不计）', sum0.conflicts === 3, sum0.conflicts)
check('1 行交换新增（60101380）', sum0.incoming === 1, sum0.incoming)
check('1 行历史只读', sum0.readonly === 1, sum0.readonly)
check('初始断点指向第 2 行（0基=1）', s.cursor === 1, s.cursor)

// 3. 历史只读行不允许裁定
const rejectReadonly = resolveField(sid, 0, '时段雨量', 'exchange')
check('历史时段裁定被拒绝', !rejectReadonly.ok, rejectReadonly.message)

// 4. 逐字段裁定：第2行时段雨量采纳交换，日累计采纳站点；其余批量采纳站点
const r1 = resolveField(sid, 1, '时段雨量', 'exchange')
check('单字段采纳交换成功', r1.ok, r1.message)
const r2 = resolveField(sid, 1, '日累计雨量', 'station')
check('同行另一字段采纳站点成功', r2.ok, r2.message)
const batch = resolveRemaining(sid, 'station')
check('剩余冲突批量采纳站点', batch.ok, batch.message)
s = getSession(sid)
check('全部冲突处理完，断点为 -1', continueCursor(s) === -1, continueCursor(s))

// 5. 未确认覆盖/凭证时入档被拦截
const a0 = archiveHandover(sid)
check('未确认覆盖不能入档', !a0.ok && a0.message.includes('覆盖范围'), a0.message)

// 6. 登记行级凭证并确认覆盖
const duty = setDutyCredentials(sid, { observer: '值班员甲', checker: '校核员乙', shift: '白班' })
check('凭证保存', duty.ok, duty.message)
const cov = confirmCoverage(sid, true)
check('覆盖范围确认', cov.ok, cov.message)

// 7. 双向清单内容
const csv = buildExchangeListCsv(getSession(sid))
check('清单含交换号', csv.includes('EXCH-20260903-02'))
check('清单标注出站/入站/历史只读', csv.includes('入站（交换来文）') && csv.includes('历史只读'))
check('清单带行级凭证（观测人/校核人）', csv.includes('李建国') && csv.includes('王慧'))

// 8. 确认入档
const arch = archiveHandover(sid)
check('入档成功', arch.ok, arch.message)
check('写入 5 行（历史只读不计入，新增站计入）', arch.written === 5, arch.written)

const rain = listRows('rainfall')
const row2 = rain.find((r) => r['记录编号'] === 'RAIN-20260902-01')
check('冲突字段按裁定：时段雨量取交换 5.6', String(row2['时段雨量']) === '5.6', row2['时段雨量'])
check('冲突字段按裁定：日累计取站点 5.2', String(row2['日累计雨量']) === '5.2', row2['日累计雨量'])
const row4 = rain.find((r) => r['记录编号'] === 'RAIN-20260902-03')
check('批量裁定：60101250 时段雨量维持站点 32.0', String(row4['时段雨量']) === '32.0', row4['时段雨量'])
const hist = rain.find((r) => r['记录编号'] === 'RAIN-20260901-01')
check('历史时段只读：12.4 未被 12.6 覆盖', String(hist['时段雨量']) === '12.4', hist['时段雨量'])
check('历史时段状态不变', String(hist['状态'] ?? hist['status']) === '已通过', hist['status'])
const added = rain.find((r) => r['站点编号'] === '60101380')
check('交换新增站已入档', !!added, '未找到 60101380')
check('新增行保留交换文件自带凭证（周敏/白班）', added && added['校核人'] === '周敏' && added['班次'] === '白班', JSON.stringify(added))

const comp = listRows('compilation')
const chk = comp.find((r) => r['来源交换号'] === 'EXCH-20260903-02')
check('整编页补了待核对成果', !!chk && chk['status'] === '待核对', JSON.stringify(chk))
check('待核对成果回指交换号', chk && chk['来源交换号'] === 'EXCH-20260903-02')

// 9. 同会话重复入档被拒
const again = archiveHandover(sid)
check('同交换号重复确认被拒', !again.ok && (again.message.includes('一个版本') || again.message.includes('已有入档版本')), again.message)

// 9b. 交换行缺行级凭证时，入档用值班登记补齐（新增站、无校核人/班次）
const pFallback = parseExchangeFile('站点编号,观测时段,时段雨量,日累计雨量,降雨强度,观测人,校核人,班次\\n60101999,2026-09-04 08:00-20:00,1.0,1.0,小雨,钱七,,')
const cFb = createHandover('EXCH-FALLBACK-01', '邻站', pFallback.rows)
setDutyCredentials(cFb.session.id, { observer: '值班员甲', checker: '校核员乙', shift: '夜班' })
confirmCoverage(cFb.session.id, true)
const archFb = archiveHandover(cFb.session.id)
check('缺凭证交换行也可入档', archFb.ok, archFb.message)
const fbRow = listRows('rainfall').find((r) => r['站点编号'] === '60101999')
check('缺失凭证按值班登记补齐', fbRow && fbRow['校核人'] === '校核员乙' && fbRow['班次'] === '夜班' && fbRow['观测人'] === '钱七', JSON.stringify(fbRow))

// 10. 再建同交换号对账单被拒
const dup = createHandover('EXCH-20260903-02', 'x', parsed.rows)
check('同交换号不能二次建单', !dup.ok, dup.message)

// 11. 模拟两个标签页并发：绕过建单检查各存一份草稿（不同 id 同交换号）
const other = JSON.parse(JSON.stringify(getSession(sid)))
other.id = 'HD-CONCURRENT-2'
other.status = 'draft'
other.archivedAt = null
other.archivedVersion = null
other.compilationResultId = null
saveSession(other)
const arch2 = archiveHandover('HD-CONCURRENT-2')
check('并发确认只落一个版本：第二份被台账拦截', !arch2.ok && arch2.message.includes('占用'), arch2.message)
check('该交换号在台账里只占 1 条', listLedger().filter((l) => l.exchangeNo === 'EXCH-20260903-02').length === 1, listLedger().length)
const compCount = listRows('compilation').filter((r) => r['来源交换号'] === 'EXCH-20260903-02').length
check('整编待核对成果也只生成 1 条', compCount === 1, compCount)

// 12. 中断续对：重置雨量数据，新建交换号只裁一部分冲突，模拟刷新后从差异行继续
resetRows('rainfall')
const p2 = parseExchangeFile(sampleExchangeCsv().replaceAll('EXCH-20260903-02', 'EXCH-RESUME-09'))
const c2 = createHandover('EXCH-RESUME-09', '上游中心站', p2.rows)
check('第二个交换号可独立建单', c2.ok, c2.message)
check('新建草稿断点指向首个未处理差异行', c2.session.cursor === 1, c2.session.cursor)
// 只裁定第 2 行的两个冲突，第 3、4 行还没处理；重开草稿应从第 3 行（0基=2）继续
resolveField(c2.session.id, 1, '时段雨量', 'exchange')
resolveField(c2.session.id, 1, '日累计雨量', 'exchange')
const reopened = getSession(c2.session.id)
check('中断后从下一条差异行继续（0基=2）', reopened.cursor === 2, reopened.cursor)
check('列表能查到全部对账单（3 已入档 + 1 草稿）', listHandovers().length === 4, listHandovers().length)

console.log(failures === 0 ? '\\n全部断言通过' : '\\n有 ' + failures + ' 条断言失败')
process.exit(failures === 0 ? 0 : 1)
`

mkdirSync('node_modules/.tmp-test', { recursive: true })
writeFileSync('node_modules/.tmp-test/entry.ts', testCode)

await esbuild({
  entryPoints: ['node_modules/.tmp-test/entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'node_modules/.tmp-test/entry.cjs',
  alias: { '@': new URL('../src', import.meta.url).pathname },
  logLevel: 'silent',
})

await import(new URL('../node_modules/.tmp-test/entry.cjs', import.meta.url).pathname)
