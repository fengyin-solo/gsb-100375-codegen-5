// 冒烟测试：在 Node 里垫一层 localStorage，验证交接服务的关键行为。
const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
}

const svc = await import('@/api/handover-service')
const { listRows } = await import('@/data/local-store')

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.error(`FAIL ${name}`, extra ?? '')
  }
}

// 1. 接收交换文件建批
const batch = svc.receiveExchangeFile()
const progress = svc.batchProgress(batch)
check('建批 10 行', progress.total === 10, progress)
check('差异 4 行（历史行不计）', progress.diffRows === 4, progress)
check('历史只读 2 行', progress.historicalRows === 2, progress)
check('重复接收返回同一断点批次', svc.receiveExchangeFile().exchangeNo === batch.exchangeNo)

// 2. 未确认覆盖范围不能入档
const early = svc.confirmArchive(batch.exchangeNo, '值班管理员')
check('未确认覆盖范围拦截入档', !early.ok && early.message.includes('覆盖范围'), early.message)

// 3. 未裁决完不能入档
svc.confirmCoverage(batch.exchangeNo)
const unresolved = svc.confirmArchive(batch.exchangeNo, '值班管理员')
check('差异未裁决拦截入档', !unresolved.ok && unresolved.message.includes('未裁决'), unresolved.message)

// 4. 行级裁决：站点原值 / 交换文件混合
svc.resolveField(batch.exchangeNo, 'RAIN-0002', '时段雨量', 'exchange')
svc.resolveField(batch.exchangeNo, 'RAIN-0003', '日累计雨量', 'station')
svc.resolveField(batch.exchangeNo, 'RAIN-0005', '时段雨量', 'exchange')
svc.resolveField(batch.exchangeNo, 'RAIN-0005', '日累计雨量', 'exchange')
svc.resolveField(batch.exchangeNo, 'RAIN-0007', '日累计雨量', 'station')
// 历史行裁决应被拒绝
svc.resolveField(batch.exchangeNo, 'RAIN-0009', '时段雨量', 'exchange')
const afterResolve = svc.getBatch(batch.exchangeNo)!
check('历史行裁决被拒绝', Object.keys(afterResolve.rows.find((r) => r.rowKey === 'RAIN-0009')!.resolutions).length === 0)
check('裁决后全部就绪', svc.batchProgress(afterResolve).allResolved)

// 5. 确认入档
const archived = svc.confirmArchive(batch.exchangeNo, '值班管理员')
check('入档成功 V1', archived.ok && !archived.already && archived.version === 1, archived)

const rain = listRows('rainfall')
const byCode = (code: string) => rain.find((r) => r['记录编号'] === code)!
check('RAIN-0002 采纳交换文件 6.9', byCode('RAIN-0002')['时段雨量'] === 6.9, byCode('RAIN-0002'))
check('RAIN-0003 保留站点原值 31.2', byCode('RAIN-0003')['日累计雨量'] === 31.2, byCode('RAIN-0003'))
check('RAIN-0005 采纳交换文件 10.2/16.0', byCode('RAIN-0005')['时段雨量'] === 10.2 && byCode('RAIN-0005')['日累计雨量'] === 16.0)
check('RAIN-0007 保留站点原值 51.3', byCode('RAIN-0007')['日累计雨量'] === 51.3)
check('历史行 RAIN-0009 只读不动 7.2', byCode('RAIN-0009')['时段雨量'] === 7.2, byCode('RAIN-0009'))

// 6. 整编页补待核对成果
const comp = listRows('compilation')
const resultRows = comp.filter((r) => r['成果编号'] === `HB-${batch.exchangeNo}`)
check('整编页补 1 笔待核对成果', resultRows.length === 1 && resultRows[0].status === '待审核' && resultRows[0]['审核人'] === '待核对', resultRows)

// 7. 并发确认只落一个版本
const again = svc.confirmArchive(batch.exchangeNo, '值班管理员')
check('重复确认返回既有版本', again.ok && again.already && again.version === 1, again)
check('整编成果不重复', listRows('compilation').filter((r) => r['成果编号'] === `HB-${batch.exchangeNo}`).length === 1)

// 8. 双向清单内容与行级凭证
const manifest = svc.buildManifest(svc.getBatch(batch.exchangeNo)!)
check('清单含上行方向', manifest.includes('上行·站点报送清单'))
check('清单含下行方向', manifest.includes('下行·入档回执清单'))
check('清单含行级凭证', manifest.includes('周校核') && manifest.includes('夜班 20:00-08:00'))
check('清单含裁决来源', manifest.includes('采纳交换文件') && manifest.includes('采纳站点原值'))
check('清单标注历史只读', manifest.includes('历史时段只读兼容'))

// 9. 断点续对账：存储里能拿回入档后的批次，新一轮交接可建批
const persisted = JSON.parse(store.get('hydrology-monitor-station:handover-batches')!)
check('批次已持久化', persisted.length === 1 && persisted[0].status === '已入档')
check('无未入档批次时活动批次为空', svc.getActiveBatch() === undefined)
const next = svc.receiveExchangeFile()
check('新一轮交接生成新交换号', next.exchangeNo !== batch.exchangeNo && next.status === '对账中', next.exchangeNo)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
