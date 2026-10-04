<template>
  <section class="handover-panel">
    <header class="page-head">
      <div>
        <h3>雨量资料交接 · 先对账后入档</h3>
        <p class="page-desc">
          值班员先预览时段雨量与日累计差异，逐行裁定字段冲突，再确认覆盖范围并下载双向交换清单；
          观测人、校核人、班次按行留痕。历史观测时段只读兼容，同一交换号并发确认只落一个版本。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="downloadTemplate">下载交换文件模板</button>
        <button class="btn ghost" type="button" @click="loadSample">载入样例交换文件</button>
      </div>
    </header>

    <form class="filter-bar handover-import" @submit.prevent="importFile">
      <label class="filter-item">
        <span>交换号</span>
        <input v-model="exchangeNoInput" placeholder="留空则取文件内交换号或自动编号" />
      </label>
      <label class="filter-item">
        <span>来文单位</span>
        <input v-model="sourceInput" placeholder="如：上游中心站" />
      </label>
      <label class="filter-item file-item">
        <span>交换文件（CSV）</span>
        <input ref="fileInput" type="file" accept=".csv,text/csv" @change="onFileChange" />
      </label>
      <button class="btn primary" type="submit">生成对账单</button>
      <span class="file-hint">没有文件可先「载入样例」，也支持直接把 CSV 粘进下方文本框</span>
    </form>
    <textarea
      v-model="pastedCsv"
      class="csv-box"
      rows="3"
      placeholder="交换号,EXCH-...&#10;站点编号,观测时段,时段雨量,...&#10;60101100,2026-09-02 08:00-20:00,5.6,..."
    ></textarea>
    <p v-if="message" class="message-text" :class="{ 'error-text': !messageOk }">{{ message }}</p>

    <div class="stat-row">
      <article v-for="item in draftStats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <table class="data-table session-table">
      <thead>
        <tr>
          <th>交换号</th><th>对账单号</th><th>来文单位</th><th>建立时间</th><th>状态</th><th>对账进度</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in sessions" :key="item.id">
          <td>{{ item.exchangeNo }}</td>
          <td>{{ item.id }}</td>
          <td>{{ item.exchangeSource || '—' }}</td>
          <td>{{ item.createdAt }}</td>
          <td>
            <span v-if="item.status === 'archived'" class="tag done">已入档 v{{ item.archivedVersion }}</span>
            <span v-else class="tag">对账草稿</span>
          </td>
          <td>{{ progressText(item) }}</td>
          <td class="row-actions">
            <button v-if="item.status === 'draft'" class="link" type="button" @click="openSession(item.id)">
              {{ item.cursor > 0 ? `从差异行 ${item.cursor + 1} 继续` : '打开对账' }}
            </button>
            <button v-else class="link" type="button" @click="openSession(item.id)">查看入档结果</button>
            <button v-if="item.status === 'draft'" class="link danger" type="button" @click="discard(item.id)">放弃草稿</button>
          </td>
        </tr>
        <tr v-if="!sessions.length">
          <td colspan="7" class="empty-state">还没有交接对账单，导入交换文件后按「先对账后入档」处理</td>
        </tr>
      </tbody>
    </table>

    <!-- 对账单工作台 -->
    <div v-if="session" class="reconcile-card">
      <header class="reconcile-head">
        <div>
          <strong>对账单 {{ session.id }}</strong>
          <span class="muted">交换号 {{ session.exchangeNo }} · {{ session.exchangeSource || '来文单位未填' }}</span>
        </div>
        <div class="row-actions">
          <button class="btn" type="button" @click="downloadList">下载双向交换清单</button>
          <button class="btn ghost" type="button" @click="closeSession">收起</button>
        </div>
      </header>

      <nav class="step-nav">
        <button
          v-for="step in steps"
          :key="step.key"
          type="button"
          class="step"
          :class="{ active: activeStep === step.key, passed: step.key < activeStep }"
          @click="goStep(step.key)"
        >
          {{ step.index }}. {{ step.label }}
        </button>
      </nav>

      <p v-if="sessionMessage" class="message-text" :class="{ 'error-text': !sessionMessageOk }">{{ sessionMessage }}</p>

      <!-- 第一步：预览差异、裁定冲突 -->
      <div v-show="activeStep === 1">
        <p class="step-tip">
          差异行 {{ summary.total }} 行：冲突 {{ summary.conflicts }}、入站新增 {{ summary.incoming }}、
          出站 {{ summary.outgoing }}、历史只读 {{ summary.readonly }}，还剩
          <strong>{{ summary.pending }}</strong> 行待裁定。时段雨量、日累计雨量已标出数值差。
        </p>
        <div class="row-actions batch-actions">
          <button class="btn" type="button" :disabled="session.status === 'archived'" @click="batchResolve('station')">剩余冲突全部采纳站点原值</button>
          <button class="btn" type="button" :disabled="session.status === 'archived'" @click="batchResolve('exchange')">剩余冲突全部采纳交换文件</button>
          <button v-if="session.cursor >= 0" class="btn ghost" type="button" @click="scrollToCursor">定位到未处理差异行 {{ session.cursor + 1 }}</button>
        </div>
        <div class="diff-scroll">
          <table class="data-table diff-table">
            <thead>
              <tr>
                <th>#</th><th>方向</th><th>站点编号</th><th>观测时段</th><th>字段</th>
                <th>站点原值</th><th>交换文件</th><th>差异</th><th>采纳</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(line, lineIndex) in session.diffLines" :key="`${line.stationNo}-${line.period}`">
                <tr
                  :ref="lineIndex === session.cursor ? setCursorRow : undefined"
                  :class="headRowClass(lineIndex, line.readonly)"
                >
                  <td :rowspan="fieldRows(line).length + 1">
                    {{ lineIndex + 1 }}
                    <span v-if="line.readonly" class="tag">历史只读</span>
                  </td>
                  <td :rowspan="fieldRows(line).length + 1">{{ directionText(line) }}</td>
                  <td :rowspan="fieldRows(line).length + 1">{{ line.stationNo }}</td>
                  <td :rowspan="fieldRows(line).length + 1">{{ line.period }}</td>
                  <td class="muted sub-row" :colspan="5">
                    结论：{{ lineConclusion(line) }}
                  </td>
                </tr>
                <tr
                  v-for="field in fieldRows(line)"
                  :key="field.field"
                  :class="detailRowClass(line, field.verdict)"
                >
                  <td>{{ field.field }}</td>
                  <td>{{ field.stationValue || '—' }}</td>
                  <td>{{ field.exchangeValue || '—' }}</td>
                  <td>
                    <span v-if="field.verdict === 'same'" class="tag done">一致</span>
                    <span v-else-if="field.verdict === 'conflict'" class="tag warn">冲突 {{ previewDelta(line, field.field) }}</span>
                    <span v-else-if="field.verdict === 'station-only'" class="tag">仅站点有</span>
                    <span v-else class="tag warn">仅交换有</span>
                  </td>
                  <td>
                    <template v-if="field.verdict === 'conflict' && !line.readonly && session.status === 'draft'">
                      <label class="radio-inline">
                        <input
                          type="radio"
                          :name="`${session.id}-${lineIndex}-${field.field}`"
                          value="station"
                          :checked="line.resolutions[field.field] === 'station'"
                          @change="resolve(lineIndex, field.field, 'station')"
                        />站点
                      </label>
                      <label class="radio-inline">
                        <input
                          type="radio"
                          :name="`${session.id}-${lineIndex}-${field.field}`"
                          value="exchange"
                          :checked="line.resolutions[field.field] === 'exchange'"
                          @change="resolve(lineIndex, field.field, 'exchange')"
                        />交换
                      </label>
                    </template>
                    <span v-else-if="field.verdict === 'conflict'" class="muted">
                      {{ line.readonly ? '只读，维持站点值' : adoptedText(line, field.field) }}
                    </span>
                    <span v-else class="muted">—</span>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <div class="step-foot">
          <button class="btn primary" type="button" @click="goStep(2)">下一步：确认覆盖范围</button>
        </div>
      </div>

      <!-- 第二步：覆盖范围 -->
      <div v-show="activeStep === 2">
        <p class="step-tip">
          勾选本次入档覆盖的「站点 + 观测时段」。历史只读时段勾上也不会覆盖；站点独有行（出站方向）不纳入写入。
        </p>
        <table class="data-table">
          <thead>
            <tr><th>覆盖</th><th>站点编号</th><th>观测时段</th><th>方向</th><th>入档雨量（时段/日累计）</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="line in coverageRows" :key="coverageKey(line.stationNo, line.period)" :class="{ 'readonly-row': line.readonly }">
              <td>
                <input
                  type="checkbox"
                  :checked="isCovered(line)"
                  :disabled="line.presence === 'station-only' || session.status === 'archived'"
                  @change="toggleCovered(line, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td>{{ line.stationNo }}</td>
              <td>{{ line.period }}</td>
              <td>{{ directionText(line) }}</td>
              <td>{{ adoptedValueFor(line, '时段雨量') }} / {{ adoptedValueFor(line, '日累计雨量') }} mm</td>
              <td class="muted">
                {{ line.readonly ? '历史时段只读兼容，维持原值' : line.presence === 'station-only' ? '出站方向，不写入本站' : '确认后按裁定结果入档' }}
              </td>
            </tr>
          </tbody>
        </table>
        <div class="credential-bar">
          <label class="filter-item">
            <span>观测人（行级凭证）</span>
            <input v-model="observerInput" :disabled="session.status === 'archived'" placeholder="观测人" />
          </label>
          <label class="filter-item">
            <span>校核人（行级凭证）</span>
            <input v-model="checkerInput" :disabled="session.status === 'archived'" placeholder="校核人" />
          </label>
          <label class="filter-item">
            <span>班次（行级凭证）</span>
            <input v-model="shiftInput" :disabled="session.status === 'archived'" placeholder="如 白班 / 夜班" />
          </label>
          <button class="btn" type="button" :disabled="session.status === 'archived'" @click="saveCredentials">保存凭证</button>
        </div>
        <div class="step-foot">
          <button class="btn" type="button" @click="goStep(1)">上一步</button>
          <button class="btn primary" type="button" :disabled="session.status === 'archived'" @click="confirmCover">确认覆盖范围</button>
          <button class="btn" type="button" @click="goStep(3)">下一步：确认入档</button>
        </div>
      </div>

      <!-- 第三步：入档 -->
      <div v-show="activeStep === 3">
        <dl class="confirm-list">
          <dt>交换号 / 对账单号</dt><dd>{{ session.exchangeNo }} / {{ session.id }}</dd>
          <dt>覆盖范围</dt><dd>{{ session.coveredKeys.length }} 个「站点 + 时段」{{ session.coverageConfirmed ? '（已确认）' : '（未确认）' }}</dd>
          <dt>行级凭证</dt><dd>观测人 {{ session.dutyObserver || '—' }} · 校核人 {{ session.dutyChecker || '—' }} · 班次 {{ session.dutyShift || '—' }}</dd>
          <dt>入档结果</dt>
          <dd v-if="session.status === 'archived'">
            {{ session.archivedAt }} 已写入，版本 v{{ session.archivedVersion }}，整编待核对成果编号 CHK-{{ String(session.compilationResultId ?? '').padStart(4, '0') }}
          </dd>
          <dd v-else>确认后雨量记录按覆盖范围入档，数据整编页面同步出现一条「待核对」成果。</dd>
        </dl>
        <div class="step-foot">
          <button class="btn" type="button" @click="goStep(2)">上一步</button>
          <button class="btn" type="button" @click="downloadList">先下载双向交换清单</button>
          <button
            class="btn primary"
            type="button"
            :disabled="session.status === 'archived' || confirming"
            @click="confirmArchive"
          >
            {{ confirming ? '确认中…' : '确认入档（同交换号只落一个版本）' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, type ComponentPublicInstance } from 'vue'

import {
  archiveHandover,
  confirmCoverage,
  continueCursor,
  createHandover,
  diffSummary,
  discardDraft,
  downloadExchangeList,
  parseExchangeFile,
  previewDelta,
  resolveField,
  resolveRemaining,
  coverageKey,
  listHandovers,
  sampleExchangeCsv,
  setDutyCredentials,
  setLineCovered,
} from '@/api/handover-service'
import { getSession } from '@/data/handover-store'
import type { HandoverDiffLine, HandoverSession } from '@/data/handover-types'
import { useSessionStore } from '@/stores/session'

const emit = defineEmits<{ (e: 'archived'): void }>()
const sessionStore = useSessionStore()

const sessions = ref<HandoverSession[]>([])
const session = ref<HandoverSession | null>(null)
const activeStep = ref(1)
const exchangeNoInput = ref('')
const sourceInput = ref('')
const pastedCsv = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const message = ref('')
const messageOk = ref(true)
const sessionMessage = ref('')
const sessionMessageOk = ref(true)
const confirming = ref(false)
const observerInput = ref('')
const checkerInput = ref('')
const shiftInput = ref(sessionStore.shiftLabel.includes('白班') ? '白班' : '夜班')
const cursorRowEl = ref<HTMLElement | null>(null)

function setCursorRow(el: Element | ComponentPublicInstance | null) {
  cursorRowEl.value = el as HTMLElement | null
}

const steps = [
  { key: 1, index: 1, label: '预览差异与裁定' },
  { key: 2, index: 2, label: '确认覆盖范围' },
  { key: 3, index: 3, label: '确认入档' },
]

const summary = computed(() => (session.value ? diffSummary(session.value) : { total: 0, conflicts: 0, incoming: 0, outgoing: 0, readonly: 0, pending: 0 }))
const draftStats = computed(() => [
  { label: '对账单总数', value: sessions.value.length },
  { label: '对账中草稿', value: sessions.value.filter((item) => item.status === 'draft').length },
  { label: '已入档版本', value: sessions.value.filter((item) => item.status === 'archived').length },
])

const coverageRows = computed(() =>
  session.value ? session.value.diffLines.filter((line) => line.presence !== 'station-only') : [],
)

function notify(text: string, ok = true) {
  message.value = text
  messageOk.value = ok
}

function notifySession(text: string, ok = true) {
  sessionMessage.value = text
  sessionMessageOk.value = ok
}

function reloadSessions(keepOpenId?: string) {
  sessions.value = listHandovers()
  if (keepOpenId) {
    session.value = getSession(keepOpenId)
  }
}

onMounted(() => reloadSessions())

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    pastedCsv.value = String(reader.result ?? '')
    notify(`已读取交换文件 ${file.name}，核对交换号后点「生成对账单」`)
  }
  reader.readAsText(file, 'utf-8')
}

function loadSample() {
  pastedCsv.value = sampleExchangeCsv()
  exchangeNoInput.value = ''
  sourceInput.value = '上游中心站'
  notify('已载入样例交换文件：含一致、冲突、新增与历史只读四类行')
}

function downloadTemplate() {
  const content = '交换号,EXCH-20260903-02\n来文单位,上游中心站\n站点编号,观测时段,时段雨量,日累计雨量,降雨强度,观测人,校核人,班次\n60101100,2026-09-02 08:00-20:00,5.6,5.6,小雨,观测人,校核人,白班'
  const blob = new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '雨量交换文件模板.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function importFile() {
  const raw = pastedCsv.value.trim()
  if (!raw) {
    notify('请先选择交换文件、载入样例或粘贴 CSV 内容', false)
    return
  }
  const parsed = parseExchangeFile(raw, exchangeNoInput.value.trim())
  if (parsed.badLines.length) {
    notify(`有 ${parsed.badLines.length} 行无法识别（缺站点编号或观测时段），已跳过`, false)
  }
  if (!sourceInput.value.trim() && parsed.source) {
    sourceInput.value = parsed.source
  }
  const result = createHandover(exchangeNoInput.value || parsed.exchangeNo, sourceInput.value || parsed.source, parsed.rows)
  notify(result.message, result.ok)
  if (result.ok && result.session) {
    pastedCsv.value = ''
    if (fileInput.value) {
      fileInput.value.value = ''
    }
    reloadSessions()
    openSession(result.session.id)
  }
}

function openSession(id: string) {
  const current = getSession(id)
  if (!current) {
    return
  }
  session.value = current
  sessionMessage.value = ''
  if (current.status === 'archived') {
    activeStep.value = 3
  } else if (current.coverageConfirmed) {
    activeStep.value = 3
  } else if (continueCursor(current) < 0) {
    activeStep.value = 2
  } else {
    activeStep.value = 1
  }
  observerInput.value = current.dutyObserver || sessionStore.operator
  checkerInput.value = current.dutyChecker
  shiftInput.value = current.dutyShift || (sessionStore.shiftLabel.includes('白班') ? '白班' : '夜班')
  // 中断恢复：打开草稿直接落到第一个未处理差异行。
  if (current.status === 'draft' && current.cursor >= 0) {
    setTimeout(scrollToCursor, 60)
  }
}

function closeSession() {
  session.value = null
}

function discard(id: string) {
  const result = discardDraft(id)
  notify(result.message, result.ok)
  if (result.ok && session.value?.id === id) {
    session.value = null
  }
  reloadSessions()
}

function progressText(item: HandoverSession): string {
  if (item.status === 'archived') {
    return `已入档 v${item.archivedVersion} · ${item.archivedAt ?? ''}`
  }
  const pending = item.diffLines.filter((line) => !line.readonly && !line.resolved).length
  return pending === 0 ? '差异已清，待确认覆盖' : `剩余 ${pending} 行待裁定`
}

function fieldRows(line: HandoverDiffLine) {
  // 一致、且双方都有值的普通字段不占表格行，只保留有信息量的差异/凭证字段。
  return line.fields.filter((item) => item.verdict !== 'same')
}

function headRowClass(lineIndex: number, readonly: boolean): Record<string, boolean> {
  return { 'cursor-row': session.value?.cursor === lineIndex, 'readonly-row': readonly }
}

function detailRowClass(line: HandoverDiffLine, verdict: string): Record<string, boolean> {
  return { 'readonly-row': line.readonly, 'conflict-row': verdict === 'conflict' }
}

function directionText(line: HandoverDiffLine): string {
  if (line.readonly) {
    return '历史只读'
  }
  if (line.presence === 'station-only') {
    return '出站'
  }
  if (line.presence === 'exchange-only') {
    return '入站新增'
  }
  return '双向核对'
}

function lineConclusion(line: HandoverDiffLine): string {
  if (line.readonly) {
    return '历史观测时段，只读兼容，维持站点原值'
  }
  const conflicts = line.fields.filter((item) => item.verdict === 'conflict')
  if (!conflicts.length) {
    if (line.presence === 'exchange-only') {
      return '交换新增行，直接采用交换文件值'
    }
    if (line.presence === 'station-only') {
      return '仅站点有，列入出站方向'
    }
    return '双方一致'
  }
  if (line.resolved) {
    return '冲突已全部裁定'
  }
  return `${conflicts.length} 个字段冲突，待值班员裁定采纳`
}

function adoptedText(line: HandoverDiffLine, field: string): string {
  const choice = line.resolutions[field]
  if (choice === 'station') {
    return '采纳站点原值'
  }
  if (choice === 'exchange') {
    return '采纳交换文件'
  }
  return '待裁定'
}

function adoptedValueFor(line: HandoverDiffLine, field: string): string {
  const target = line.fields.find((item) => item.field === field)
  if (!target) {
    return '—'
  }
  if (target.verdict === 'conflict') {
    return line.resolutions[field] === 'station' ? target.stationValue : target.exchangeValue
  }
  return target.verdict === 'exchange-only' ? target.exchangeValue : target.stationValue
}

function applyMutation(result: { ok: boolean; message: string; session?: HandoverSession }) {
  notifySession(result.message, result.ok)
  if (result.ok && result.session) {
    session.value = result.session
    reloadSessions(result.session.id)
  }
}

function resolve(lineIndex: number, field: string, choice: 'station' | 'exchange') {
  if (!session.value) {
    return
  }
  applyMutation(resolveField(session.value.id, lineIndex, field, choice))
}

function batchResolve(choice: 'station' | 'exchange') {
  if (!session.value) {
    return
  }
  const result = resolveRemaining(session.value.id, choice)
  notifySession(result.ok ? '剩余冲突已统一裁定' : result.message, result.ok)
  reloadSessions(session.value.id)
  session.value = getSession(session.value.id)
}

function isCovered(line: HandoverDiffLine): boolean {
  return session.value?.coveredKeys.includes(coverageKey(line.stationNo, line.period)) ?? false
}

function toggleCovered(line: HandoverDiffLine, checked: boolean) {
  if (!session.value) {
    return
  }
  applyMutation(setLineCovered(session.value.id, coverageKey(line.stationNo, line.period), checked))
}

function saveCredentials() {
  if (!session.value) {
    return
  }
  applyMutation(
    setDutyCredentials(session.value.id, {
      observer: observerInput.value,
      checker: checkerInput.value,
      shift: shiftInput.value,
    }),
  )
}

function confirmCover() {
  if (!session.value) {
    return
  }
  const result = confirmCoverage(session.value.id, true)
  notifySession(result.ok ? '覆盖范围已确认，可进入入档步骤' : result.message, result.ok)
  reloadSessions(session.value.id)
  session.value = getSession(session.value.id)
}

function goStep(key: number) {
  if (!session.value) {
    return
  }
  if (key === 2 && continueCursor(session.value) >= 0) {
    notifySession('还有冲突未裁定，请先完成第 1 步', false)
    return
  }
  if (key === 3 && !session.value.coverageConfirmed) {
    notifySession('请先在第 2 步确认覆盖范围', false)
    return
  }
  activeStep.value = key
  sessionMessage.value = ''
}

function scrollToCursor() {
  cursorRowEl.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function downloadList() {
  if (!session.value) {
    return
  }
  const result = downloadExchangeList(session.value.id)
  notifySession(result.message, result.ok)
}

function confirmArchive() {
  if (!session.value) {
    return
  }
  confirming.value = true
  // 锁一下按钮，模拟并发窗口；同交换号真正的去重由交换号台账保证。
  setTimeout(() => {
    const result = archiveHandover(session.value!.id)
    confirming.value = false
    notifySession(result.message, result.ok)
    if (result.ok && result.session) {
      session.value = result.session
      activeStep.value = 3
      reloadSessions(result.session.id)
      emit('archived')
    }
  }, 120)
}
</script>

<style scoped>
.handover-panel {
  margin-top: 24px;
  border-top: 2px dashed var(--border);
  padding-top: 16px;
}
.handover-import { align-items: flex-end; }
.file-item { min-width: 220px; }
.file-hint { color: var(--muted); font-size: 12px; }
.csv-box {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  margin-bottom: 8px;
}
.message-text { font-size: 13px; color: #067647; }
.session-table { margin: 8px 0 12px; }
.tag {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
  background: #eef2f7;
  color: var(--muted);
}
.tag.done { background: #e7f6ec; color: #067647; }
.tag.warn { background: #fef3e2; color: #b54708; }
.link.danger { color: #b42318; }
.reconcile-card {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  padding: 14px;
}
.reconcile-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.reconcile-head .muted { color: var(--muted); font-size: 12px; margin-left: 10px; }
.step-nav { display: flex; gap: 8px; margin-bottom: 12px; }
.step {
  border: 1px solid var(--border);
  background: #f6f8fb;
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
}
.step.active { background: var(--brand); border-color: var(--brand); color: #fff; }
.step.passed { background: #e7f6ec; border-color: #a6d7b8; color: #067647; }
.step-tip { font-size: 13px; color: var(--muted); }
.batch-actions { margin: 8px 0; }
.diff-scroll { max-height: 460px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.diff-table td.sub-row { background: #f8fafc; }
.cursor-row td { background: #fff7d6 !important; }
.readonly-row { background: #f1f5f9; color: var(--muted); }
.conflict-row td:nth-child(6), .conflict-row td:nth-child(7) { font-weight: 600; }
.radio-inline { margin-right: 10px; font-size: 12px; white-space: nowrap; }
.step-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.credential-bar { display: flex; gap: 12px; align-items: flex-end; margin-top: 12px; }
.confirm-list { display: grid; grid-template-columns: 140px 1fr; gap: 8px 12px; font-size: 13px; }
.confirm-list dt { color: var(--muted); }
.confirm-list dd { margin: 0; }
.muted { color: var(--muted); font-size: 12px; }
</style>
