<script setup lang="ts">
/**
 * /backup 整治建议与结构版本导出
 * 维护建议措施与状态流转，导入导出全量 JSON，重置演示数据。
 * 消费全部模型；复用 <EmptyPanel>、<LevelTag>、<FilterBar>、<StatBadge>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Download, Edit, Plus, Refresh, RefreshRight, Right, Upload } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import LevelTag from '@/components/common/LevelTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useCrackStore } from '@/stores/crackStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  DB_VERSION,
  clearAllTables,
  countAll,
  db,
  exportSnapshot,
  importSnapshot,
  readLastBackupAt,
  readStampedDbVersion,
  resetDatabase,
  stampBackupTime,
  type AdviceRow,
  type BackupPayload
} from '@/utils/db'
import {
  ADVICE_LEVELS,
  ADVICE_MEASURES,
  ADVICE_STATES,
  ADVICE_STATE_FLOW,
  EMPTY_ADVICE_DRAFT,
  type AdviceDraft,
  type AdviceState
} from '@/types/advice'
import { exportCrackCsv } from '@/utils/export'
import { formatMm } from '@/utils/rate'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const crackStore = useCrackStore()
const surveyStore = useSurveyStore()
const sectionStore = useSectionStore()
const adviceTable = useIdbTable<AdviceRow>((database) => database.advices, { sortByUpdatedAt: false })

const counts = ref<Record<string, number>>({})
const lastBackupAt = ref<string | null>(readLastBackupAt())
const stampedVersion = ref<number>(readStampedDbVersion())
const stateFilter = ref<AdviceState[]>([])
const keyword = ref('')

void refreshCounts()

async function refreshCounts(): Promise<void> {
  counts.value = await countAll()
}

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: keyword.value,
  state: stateFilter.value
}))

const filterSelects = computed(() => [
  { key: 'state', label: '建议状态', options: ADVICE_STATES.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  keyword.value = String(model.keyword ?? '')
  stateFilter.value = (Array.isArray(model.state) ? model.state : []) as AdviceState[]
}

/* ------------------------------ 建议行 ------------------------------ */

function crackOf(crackId: string) {
  return crackStore.cracks.find((crack) => crack.id === crackId) ?? null
}

const rows = computed(() =>
  adviceTable.rows.value
    .filter((advice) => {
      if (stateFilter.value.length > 0 && !stateFilter.value.includes(advice.state)) return false
      const text = keyword.value.trim().toLowerCase()
      if (text.length === 0) return true
      const crack = crackOf(advice.crackId)
      return (
        (crack ? crack.code.toLowerCase().includes(text) : false) ||
        advice.measure.toLowerCase().includes(text) ||
        advice.basis.toLowerCase().includes(text)
      )
    })
    .sort((a, b) => ADVICE_LEVELS.indexOf(b.level) - ADVICE_LEVELS.indexOf(a.level))
)

const pendingCount = computed(() => adviceTable.rows.value.filter((item) => item.state === '待下发').length)
const issuedCount = computed(() => adviceTable.rows.value.filter((item) => item.state === '已下发').length)
const doneCount = computed(() => adviceTable.rows.value.filter((item) => item.state === '已完成').length)

/* ------------------------------ 表单 ------------------------------ */

const dialogVisible = ref(false)
const dialogTitle = ref('新建整治建议')
const formRef = ref<FormInstance>()
const form = reactive<AdviceDraft>({ ...EMPTY_ADVICE_DRAFT })
let editingId: string | null = null

const rules: FormRules = {
  crackId: [{ required: true, message: '请选择裂缝', trigger: 'change' }],
  basis: [{ required: true, message: '请填写判定依据', trigger: 'blur' }]
}

const crackOptions = computed(() =>
  crackStore.cracks.map((crack) => {
    const ring = sectionStore.ringById.get(crack.ringId)
    const section = sectionStore.sectionById.get(crack.sectionId)
    return {
      label: `${crack.code} · ${section ? section.line : '未知'}${ring ? ` 第${ring.ringNo}环` : ''} · 当前 ${crack.widthMm.toFixed(2)} mm`,
      value: crack.id
    }
  })
)

function openCreate(): void {
  editingId = null
  dialogTitle.value = '新建整治建议'
  const fallback = crackStore.cracks[0]
  Object.assign(form, {
    ...EMPTY_ADVICE_DRAFT,
    crackId: fallback ? fallback.id : '',
    basis: fallback ? `${fallback.code} 复测宽度持续增长，建议先观测后处置。` : ''
  })
  dialogVisible.value = true
}

function openEdit(advice: AdviceRow): void {
  editingId = advice.id
  dialogTitle.value = `编辑整治建议 · ${crackOf(advice.crackId)?.code ?? ''}`
  Object.assign(form, {
    crackId: advice.crackId,
    level: advice.level,
    measure: advice.measure,
    basis: advice.basis,
    state: advice.state
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const instance = formRef.value
  if (!instance) return
  const valid = await instance.validate().catch(() => false)
  if (!valid) return
  if (editingId) {
    await adviceTable.update(editingId, { ...form })
    ElMessage.success('整治建议已更新')
  } else {
    await adviceTable.create({ ...form }, 'ad')
    ElMessage.success('整治建议已创建')
  }
  dialogVisible.value = false
  await refreshCounts()
}

async function removeAdvice(advice: AdviceRow): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `确认删除「${crackOf(advice.crackId)?.code ?? '该裂缝'}」的整治建议？`,
    '删除确认',
    { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await adviceTable.remove(advice.id)
  ElMessage.success('整治建议已删除')
  await refreshCounts()
}

async function advance(advice: AdviceRow): Promise<void> {
  const next = ADVICE_STATE_FLOW[advice.state]
  if (!next) {
    ElMessage.info('该建议已完成闭环')
    return
  }
  await adviceTable.update(advice.id, { state: next })
  ElMessage.success(`建议状态已推进为「${next}」`)
  await refreshCounts()
}

/* ---------------------------- 备份与恢复 ---------------------------- */

const fileInput = ref<HTMLInputElement | null>(null)

async function exportAll(): Promise<void> {
  const payload = await exportSnapshot()
  const filename = `gbtunnelcrack-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  const iso = new Date().toISOString()
  stampBackupTime(iso)
  lastBackupAt.value = iso
  ElMessage.success(`已导出全量存档 ${filename}`)
}

function triggerImport(): void {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const payload = JSON.parse(text) as BackupPayload
    if (payload.app !== 'gbtunnelcrack') {
      ElMessage.error('存档文件格式不匹配（缺少 app: gbtunnelcrack 标识）')
      return
    }
    const confirmed = await ElMessageBox.confirm(
      '导入将覆盖当前全部本地数据，确认继续？',
      '导入确认',
      { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' }
    ).catch(() => false)
    if (!confirmed) return
    await importSnapshot(payload)
    ElMessage.success('存档已导入')
    await refreshCounts()
  } catch (error) {
    ElMessage.error(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    target.value = ''
  }
}

async function clearData(): Promise<void> {
  const confirmed = await ElMessageBox.confirm('清空后所有本地数据将被删除且不可恢复，确认清空？', '清空确认', {
    type: 'warning',
    confirmButtonText: '确认清空',
    cancelButtonText: '取消'
  }).catch(() => false)
  if (!confirmed) return
  await clearAllTables()
  ElMessage.success('本地数据已清空')
  await refreshCounts()
}

async function reseed(): Promise<void> {
  const confirmed = await ElMessageBox.confirm('重置将清空现有数据并重新写入演示数据，确认继续？', '重置确认', {
    type: 'warning',
    confirmButtonText: '重置并播种',
    cancelButtonText: '取消'
  }).catch(() => false)
  if (!confirmed) return
  await resetDatabase()
  stampedVersion.value = DB_VERSION
  ElMessage.success('已重置为演示数据')
  await refreshCounts()
}

async function exportCsv(): Promise<void> {
  const [sections, rings, cracks, surveys, advices] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray(),
    db.advices.toArray()
  ])
  const filename = exportCrackCsv(sections, rings, cracks, surveys, advices)
  ElMessage.success(`已导出 ${filename}`)
}

const adviceStateText = (state: AdviceState): string => state

function adviceRowKey(row: AdviceRow): string {
  return row.id
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">整治建议与数据备份</h2>
        <p class="page-head__desc">
          维护建议措施与状态流转（待下发 → 已下发 → 已完成），并导出/导入 IndexedDB 全量 JSON 存档。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button :icon="Download" @click="exportCsv">导出裂缝台账 CSV</el-button>
        <el-button type="primary" :icon="Plus" :disabled="crackStore.cracks.length === 0" @click="openCreate">
          新建建议
        </el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="建议总数" :value="adviceTable.rows.value.length" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="待下发" :value="pendingCount" suffix="条" icon="Histogram" tone="warning" />
      <StatBadge label="已下发" :value="issuedCount" suffix="条" icon="DataLine" tone="info" />
      <StatBadge label="已完成" :value="doneCount" suffix="条" icon="CircleCheckFilled" tone="success" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索裂缝编号 / 措施 / 依据"
      @change="onFilterChange"
    />

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title">整治建议（{{ rows.length }}）</h3>
        <span class="muted">按等级从高到低排列，可逐条推进状态</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="还没有整治建议"
        description="可在「速率分级」页按速率一键生成建议草稿，也可在此手工新建。"
        action-text="新建建议"
        compact
        :show-seed="crackStore.cracks.length === 0"
        @action="openCreate"
        @seed="reseed"
      />

      <el-table v-else :data="rows" border stripe :row-key="adviceRowKey">
        <el-table-column label="裂缝编号" width="140">
          <template #default="{ row }">
            <strong>{{ crackOf(row.crackId)?.code ?? '（裂缝已删除）' }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="月均速率" width="130">
          <template #default="{ row }">
            {{ (surveyStore.rateMap[row.crackId] ?? 0).toFixed(3) }} mm/月
          </template>
        </el-table-column>
        <el-table-column label="当前宽度" width="120">
          <template #default="{ row }">
            {{ formatMm(crackOf(row.crackId)?.widthMm ?? 0) }}
          </template>
        </el-table-column>
        <el-table-column label="建议等级" width="150">
          <template #default="{ row }">
            <LevelTag :level="row.level" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="建议措施" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.measure }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="basis" label="判定依据" min-width="240" show-overflow-tooltip />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.state === '已完成' ? 'success' : row.state === '已下发' ? 'primary' : 'warning'"
            >
              {{ adviceStateText(row.state) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openEdit(row)">
              <el-icon><Edit /></el-icon> 编辑
            </el-button>
            <el-button size="small" text type="primary" :disabled="!ADVICE_STATE_FLOW[row.state as AdviceState]" @click="advance(row)">
              <el-icon><Right /></el-icon>
              {{ ADVICE_STATE_FLOW[row.state as AdviceState] ? `转${ADVICE_STATE_FLOW[row.state as AdviceState]}` : '已闭环' }}
            </el-button>
            <el-button size="small" text type="danger" @click="removeAdvice(row)">
              <el-icon><Delete /></el-icon> 删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="panel">
      <h3 class="panel-title">结构版本与本地数据</h3>
      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="IndexedDB 库名">gbtunnelcrack</el-descriptions-item>
        <el-descriptions-item label="数据结构版本">v{{ DB_VERSION }}（localStorage 记录 v{{ stampedVersion }}）</el-descriptions-item>
        <el-descriptions-item label="最近备份时间">{{ lastBackupAt ?? '尚未备份' }}</el-descriptions-item>
        <el-descriptions-item label="区间 / 环片">
          {{ counts.sections ?? 0 }} / {{ counts.rings ?? 0 }}
        </el-descriptions-item>
        <el-descriptions-item label="裂缝 / 复测">
          {{ counts.cracks ?? 0 }} / {{ counts.surveys ?? 0 }}
        </el-descriptions-item>
        <el-descriptions-item label="整治建议">{{ counts.advices ?? 0 }}</el-descriptions-item>
      </el-descriptions>

      <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px">
        <el-button type="primary" :icon="Download" @click="exportAll">导出全量 JSON</el-button>
        <el-button :icon="Upload" @click="triggerImport">导入 JSON 存档</el-button>
        <el-button :icon="RefreshRight" @click="reseed">重置为演示数据</el-button>
        <el-button type="danger" plain :icon="Delete" @click="clearData">清空本地数据</el-button>
        <el-button :icon="Refresh" @click="refreshCounts">刷新统计</el-button>
      </div>
      <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFileChange" />
    </div>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="关联裂缝" prop="crackId">
          <el-select v-model="form.crackId" filterable style="width: 100%">
            <el-option v-for="item in crackOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="建议等级" prop="level">
          <el-select v-model="form.level" style="width: 100%">
            <el-option v-for="item in ADVICE_LEVELS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="建议措施" prop="measure">
          <el-radio-group v-model="form.measure">
            <el-radio-button v-for="item in ADVICE_MEASURES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="判定依据" prop="basis">
          <el-input v-model="form.basis" type="textarea" :rows="3" placeholder="如：月均速率 0.310 mm/月 超过严重阈值" />
        </el-form-item>
        <el-form-item label="状态" prop="state">
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in ADVICE_STATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.panel-title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
}

.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}
</style>
