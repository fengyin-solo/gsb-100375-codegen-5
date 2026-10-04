<template>
  <section class="page" data-module="rainfall-handover">
    <header class="page-head">
      <div>
        <h2>雨量资料交接 · 先对账后入档</h2>
        <p class="page-desc">
          值班员先预览时段雨量与日累计差异，确认覆盖范围并下载双向交换清单后，逐行裁决字段冲突再确认入档；观测人、校核人、班次作为行级凭证随行流转。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn ghost" to="/rainfall">返回雨量观测</RouterLink>
      </div>
    </header>

    <div v-if="!batch" class="panel intro-panel">
      <h3>尚未接收到交换文件</h3>
      <p class="page-desc">
        交接流程：接收交换文件 → 对账预览差异 → 确认覆盖范围 → 下载双向交换清单 → 裁决差异行 → 确认入档。
        入档后数据整编页会一并补上待核对成果；同一交换号并发确认只落一个版本。
      </p>
      <p v-if="lastResult" class="ok-text">{{ lastResult }}</p>
      <div class="intro-actions">
        <button class="btn primary" type="button" @click="receive">接收交换文件并开始对账</button>
        <RouterLink v-if="lastResult" class="btn" to="/compilation">前往数据整编查看待核对成果</RouterLink>
      </div>
    </div>

    <template v-else>
      <ol class="stepper">
        <li v-for="step in steps" :key="step.label" :class="step.state">{{ step.label }}</li>
      </ol>

      <div class="panel batch-bar">
        <span>交换号 <strong>{{ batch.exchangeNo }}</strong></span>
        <span class="tag" :class="batch.status === '已入档' ? 'ok' : 'warn'">{{ batch.status }}</span>
        <span v-if="batch.version > 0">版本 V{{ batch.version }}</span>
        <span>建账 {{ formatTime(batch.createdAt) }}</span>
        <span v-if="batch.archivedAt">入档 {{ formatTime(batch.archivedAt) }}</span>
      </div>

      <div v-if="resumeNotice" class="notice">
        <span>已恢复上次对账进度，还有 {{ progress.diffRows - progress.resolvedRows }} 行差异待裁决，已从首个差异行继续。</span>
        <button class="link" type="button" @click="scrollToFirstPending">定位到差异行</button>
      </div>

      <div class="panel">
        <h3>一、对账预览与差异裁决（时段雨量 / 日累计雨量）</h3>
        <p class="page-desc">
          差异行 {{ progress.diffRows }} 行，已裁决 {{ progress.resolvedRows }} 行；
          历史观测时段 {{ progress.historicalRows }} 行只读兼容，仅展示差异、不参与裁决与入档。
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th>记录编号</th>
              <th>站点编号</th>
              <th>观测时段</th>
              <th>时段雨量（站点 / 交换）</th>
              <th>日累计雨量（站点 / 交换）</th>
              <th>行级凭证</th>
              <th>字段冲突裁决</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in batch.rows"
              :id="`diff-${row.rowKey}`"
              :key="row.rowKey"
              :class="{ 'row-diff': row.diffs.length > 0 && !row.historical, 'row-historical': row.historical }"
            >
              <td>{{ row.记录编号 }}</td>
              <td>{{ row.站点编号 }}</td>
              <td>
                {{ row.观测时段 }}
                <span v-if="row.historical" class="tag readonly">历史只读</span>
              </td>
              <td>
                <span>{{ row.station.时段雨量 ?? '缺报' }}</span>
                <span class="cell-sep">/</span>
                <span :class="{ 'diff-cell': row.diffs.includes('时段雨量') }">{{ row.exchange.时段雨量 }}</span>
              </td>
              <td>
                <span>{{ row.station.日累计雨量 ?? '缺报' }}</span>
                <span class="cell-sep">/</span>
                <span :class="{ 'diff-cell': row.diffs.includes('日累计雨量') }">{{ row.exchange.日累计雨量 }}</span>
              </td>
              <td class="cred-cell">
                <span>观测人：{{ row.观测人 }}</span>
                <span>校核人：{{ row.校核人 }}</span>
                <span>班次：{{ row.班次 }}</span>
              </td>
              <td>
                <span v-if="row.historical" class="tag readonly">只读兼容，不入裁决</span>
                <span v-else-if="row.missingAtStation" class="tag warn">站点缺报，本次不入档</span>
                <span v-else-if="row.diffs.length === 0" class="tag ok">一致</span>
                <div v-else class="resolve-group">
                  <div v-for="field in row.diffs" :key="field" class="resolve-item">
                    <span class="resolve-field">{{ field }}</span>
                    <label>
                      <input
                        type="radio"
                        :name="`${row.rowKey}-${field}`"
                        :checked="row.resolutions[field] === 'station'"
                        @change="resolve(row.rowKey, field, 'station')"
                      />
                      站点原值 {{ row.station[field as '时段雨量' | '日累计雨量'] ?? '缺报' }}
                    </label>
                    <label>
                      <input
                        type="radio"
                        :name="`${row.rowKey}-${field}`"
                        :checked="row.resolutions[field] === 'exchange'"
                        @change="resolve(row.rowKey, field, 'exchange')"
                      />
                      交换文件 {{ row.exchange[field as '时段雨量' | '日累计雨量'] }}
                    </label>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="panel">
        <h3>二、确认覆盖范围</h3>
        <p class="coverage-line">
          覆盖站点：
          <span v-for="station in coverageStations" :key="station" class="tag">{{ station }}</span>
        </p>
        <p class="coverage-line">观测时段范围：{{ coverageRange }}</p>
        <p class="coverage-line">
          交接行数 {{ progress.total }} 行（含历史只读 {{ progress.historicalRows }} 行<span v-if="progress.missingRows">、站点缺报 {{ progress.missingRows }} 行</span>）
        </p>
        <button v-if="!batch.coverageConfirmed" class="btn primary" type="button" @click="confirmScope">
          确认覆盖范围
        </button>
        <span v-else class="tag ok">覆盖范围已确认</span>
      </div>

      <div class="panel">
        <h3>三、双向交换清单</h3>
        <p class="page-desc">清单含上行站点报送与下行入档回执两个方向，行级凭证（观测人 / 校核人 / 班次）随清单一并下载。</p>
        <button class="btn" type="button" :disabled="!batch.coverageConfirmed" @click="download">
          下载双向交换清单
        </button>
        <span v-if="!batch.coverageConfirmed" class="hint-text">请先确认覆盖范围</span>
      </div>

      <div class="panel">
        <h3>四、确认入档</h3>
        <p class="page-desc">
          入档后裁决结果回写雨量记录，数据整编页一并补上待核对成果；同一交换号并发确认只落一个版本。
        </p>
        <button
          class="btn primary"
          type="button"
          :disabled="!canArchive"
          @click="archive"
        >
          确认入档
        </button>
        <span v-if="!batch.coverageConfirmed" class="hint-text">请先确认覆盖范围</span>
        <span v-else-if="!progress.allResolved" class="hint-text">
          还有 {{ progress.diffRows - progress.resolvedRows }} 行差异未裁决
        </span>
      </div>
    </template>

    <footer class="page-foot">
      <span v-if="batch">交换号 {{ batch.exchangeNo }} · 差异 {{ progress.diffRows }} 行 · 已裁决 {{ progress.resolvedRows }} 行</span>
      <span v-else>雨量资料交接</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'

import {
  batchProgress,
  confirmArchive,
  confirmCoverage,
  downloadManifest,
  getActiveBatch,
  receiveExchangeFile,
  resolveField,
  rowResolved,
} from '@/api/handover-service'
import type { HandoverBatch, HandoverResolution } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const batch = ref<HandoverBatch | null>(null)
const errorMessage = ref('')
const okMessage = ref('')
const lastResult = ref('')
const resumeNotice = ref(false)

const progress = computed(() =>
  batch.value
    ? batchProgress(batch.value)
    : { total: 0, diffRows: 0, resolvedRows: 0, historicalRows: 0, missingRows: 0, allResolved: true },
)

const canArchive = computed(
  () => !!batch.value && batch.value.coverageConfirmed && progress.value.allResolved,
)

const coverageStations = computed(() =>
  batch.value ? [...new Set(batch.value.rows.map((row) => row.站点编号))] : [],
)

const coverageRange = computed(() => {
  if (!batch.value) {
    return '—'
  }
  const dates = batch.value.rows
    .map((row) => row.观测时段.match(/\d{4}-\d{2}-\d{2}/)?.[0])
    .filter((item): item is string => !!item)
    .sort()
  return dates.length ? `${dates[0]} 至 ${dates[dates.length - 1]}` : '—'
})

const steps = computed(() => {
  const done = [
    !!batch.value,
    !!batch.value?.coverageConfirmed,
    !!batch.value?.coverageConfirmed,
    progress.value.allResolved,
    batch.value?.status === '已入档',
  ]
  const labels = ['1 对账预览', '2 确认覆盖范围', '3 下载交换清单', '4 差异裁决', '5 确认入档']
  const firstOpen = done.findIndex((item) => !item)
  return labels.map((label, index) => ({
    label,
    state: done[index] ? 'done' : index === firstOpen ? 'active' : '',
  }))
})

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN')
}

function refresh() {
  batch.value = getActiveBatch() ?? null
}

function receive() {
  errorMessage.value = ''
  batch.value = receiveExchangeFile()
  okMessage.value = `交换文件已接收，交换号 ${batch.value.exchangeNo}，请先预览差异`
}

function resolve(rowKey: string, field: string, choice: HandoverResolution) {
  if (!batch.value) {
    return
  }
  const updated = resolveField(batch.value.exchangeNo, rowKey, field, choice)
  if (updated) {
    batch.value = updated
  }
}

function confirmScope() {
  if (!batch.value) {
    return
  }
  const updated = confirmCoverage(batch.value.exchangeNo)
  if (updated) {
    batch.value = updated
    okMessage.value = '覆盖范围已确认，可下载双向交换清单'
  }
}

function download() {
  if (!batch.value || !batch.value.coverageConfirmed) {
    return
  }
  downloadManifest(batch.value)
  okMessage.value = '双向交换清单已生成下载'
}

function archive() {
  if (!batch.value) {
    return
  }
  errorMessage.value = ''
  okMessage.value = ''
  const result = confirmArchive(batch.value.exchangeNo, store.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  lastResult.value = result.message
  okMessage.value = result.message
  refresh()
}

function firstPendingRowKey(): string | null {
  if (!batch.value) {
    return null
  }
  const row = batch.value.rows.find(
    (item) => !item.historical && !item.missingAtStation && item.diffs.length > 0 && !rowResolved(item),
  )
  return row ? row.rowKey : null
}

function scrollToFirstPending() {
  const key = firstPendingRowKey()
  if (!key) {
    return
  }
  document.getElementById(`diff-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

onMounted(async () => {
  refresh()
  // 中断恢复：有未裁决差异时提示并自动定位到首个差异行，从断点继续。
  if (batch.value && progress.value.diffRows > progress.value.resolvedRows) {
    resumeNotice.value = true
    await nextTick()
    scrollToFirstPending()
  }
})
</script>
