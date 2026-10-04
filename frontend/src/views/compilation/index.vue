<template>
  <section class="page" data-module="compilation">
    <header class="page-head">
      <div>
        <h2>数据整编管理</h2>
        <p class="page-desc">维护整编成果，围绕成果编号、整编年份、站点编号、整编类型做登记、筛选与状态流转；雨量交接入档后这里会同步出现待核对成果。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记整编成果</button>
        <button class="btn" type="button" @click="exportRows">导出数据整编清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="check-banner">
      <h3>雨量交接待核对成果</h3>
      <p class="page-desc">
        来自「先对账后入档」的雨量资料交接，核对时段雨量、日累计与行级凭证无误后点「核对通过」转为待审核；
        有疑问可凭来源交换号回雨量页查对账单。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>成果编号</th><th>整编年份</th><th>站点编号</th><th>原始记录数</th>
            <th>整编人</th><th>审核人</th><th>来源交换号</th><th>状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in checkRows" :key="String(row.id)">
            <td>{{ row['成果编号'] }}</td>
            <td>{{ row['整编年份'] }}</td>
            <td>{{ row['站点编号'] }}</td>
            <td>{{ row['原始记录数'] }}</td>
            <td>{{ row['整编人'] }}</td>
            <td>{{ row['审核人'] }}</td>
            <td><strong>{{ row['来源交换号'] }}</strong></td>
            <td><span class="tag warn">待核对</span></td>
            <td class="row-actions">
              <button class="link" type="button" @click="runAction('核对通过', row)">核对通过</button>
            </td>
          </tr>
          <tr v-if="!checkRows.length">
            <td colspan="9" class="empty-state">暂无待核对成果，雨量交接确认入档后会自动补到这里</td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'check-row': row.status === '待核对' }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无数据整编数据，可先登记整编成果</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据整编记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('compilation')
const columns = ["成果编号", "整编年份", "站点编号", "整编类型", "原始记录数", "整编人", "审核人", "来源交换号", "整编状态"]
const baseActions = ["开始整编", "提交审核", "驳回整编"]
const statuses = ["待整编", "整编中", "待审核", "已刊印", "已驳回", "待核对"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["成果编号", "整编年份", "站点编号", "来源交换号"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const checkRows = computed(() => rows.value.filter((row) => String(row.status) === '待核对'))
const stats = computed(() => [
  { label: "待整编年度", value: rows.value.filter((row) => String(row.status) === '待整编').length },
  { label: "整编中年度", value: rows.value.filter((row) => String(row.status) === '整编中').length },
  { label: "待核对交接成果", value: checkRows.value.length },
  { label: "已刊印成果", value: rows.value.filter((row) => String(row.status) === '已刊印').length },
])

function actionsFor(row: EntryRow): string[] {
  // 交接回写的待核对成果只走核对动作，不和常规整编动作混用。
  return String(row.status) === '待核对' ? ["核对通过"] : baseActions
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '整编成果登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据整编列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.check-banner {
  border: 1px solid var(--border);
  border-left: 4px solid #d97706;
  border-radius: 8px;
  background: #fffdf5;
  padding: 12px;
  margin-bottom: 14px;
}
.check-banner h3 { margin: 0 0 4px; font-size: 15px; }
.tag {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
  background: #fef3e2;
  color: #b54708;
}
.tag.warn { background: #fef3e2; color: #b54708; }
.check-row { background: #fffdf5; }
</style>
