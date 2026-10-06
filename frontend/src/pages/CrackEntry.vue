<script setup lang="ts">
/**
 * /cracks 裂缝初测录入
 * 按环片登记部位/走向/宽度/长度，支持勾选批量改状态、单条状态流转与删除。
 * 消费 Crack、Ring；复用 <LevelTag>、<FilterBar>、<EmptyPanel>、<StatBadge>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Download, Edit, Plus, Refresh, Right } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import LevelTag from '@/components/common/LevelTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useCrackStore, type CrackEnriched } from '@/stores/crackStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useSurveyStore } from '@/stores/surveyStore'
import {
  CRACK_STATE_FLOW,
  EMPTY_CRACK_DRAFT,
  type Crack,
  type CrackDraft,
  type CrackDirection,
  type CrackPosition,
  type CrackState
} from '@/types/crack'
import { formatMileage } from '@/types/section'
import { exportCrackCsv } from '@/utils/export'
import { db } from '@/utils/db'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const crackStore = useCrackStore()
const sectionStore = useSectionStore()
const surveyStore = useSurveyStore()

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: crackStore.filter.keyword,
  line: crackStore.filter.lines,
  position: crackStore.filter.positions,
  direction: crackStore.filter.directions,
  state: crackStore.filter.states,
  section: crackStore.filter.sectionId
}))

const filterSelects = computed(() => [
  { key: 'line', label: '线路', options: sectionStore.lineOptions },
  {
    key: 'section',
    label: '区间',
    multiple: false,
    options: sectionStore.sections.map((section) => ({
      label: `${section.line} ${formatMileage(section.startMileage)}～${formatMileage(section.endMileage)}`,
      value: section.id
    }))
  },
  { key: 'position', label: '部位', options: crackStore.positionOptions.map((item) => ({ label: item, value: item })) },
  { key: 'direction', label: '走向', options: crackStore.directionOptions.map((item) => ({ label: item, value: item })) },
  { key: 'state', label: '状态', options: crackStore.stateOptions.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  crackStore.patchFilter({
    keyword: String(model.keyword ?? ''),
    lines: Array.isArray(model.line) ? model.line : [],
    positions: (Array.isArray(model.position) ? model.position : []) as CrackPosition[],
    directions: (Array.isArray(model.direction) ? model.direction : []) as CrackDirection[],
    states: (Array.isArray(model.state) ? model.state : []) as CrackState[],
    sectionId: typeof model.section === 'string' ? model.section : ''
  })
}

/* ---------------------------- 环片下拉 ---------------------------- */

const ringOptions = computed(() =>
  sectionStore.rings.map((ring) => {
    const section = sectionStore.sectionById.get(ring.sectionId)
    return {
      label: `${section ? section.line : '未知线路'} · 第 ${ring.ringNo} 环 · ${formatMileage(ring.mileage)}`,
      value: ring.id
    }
  })
)

/* ---------------------------- 裂缝表单 ---------------------------- */

const dialogVisible = ref(false)
const dialogTitle = ref('新增裂缝')
const formRef = ref<FormInstance>()
const form = reactive<CrackDraft>({ ...EMPTY_CRACK_DRAFT })
let editingId: string | null = null

const rules: FormRules = {
  ringId: [{ required: true, message: '请选择所属环片', trigger: 'change' }],
  code: [{ required: true, message: '请填写裂缝编号', trigger: 'blur' }],
  widthMm: [{ required: true, message: '请填写初测宽度', trigger: 'blur' }],
  lengthMm: [{ required: true, message: '请填写初测长度', trigger: 'blur' }]
}

function openCreate(): void {
  editingId = null
  dialogTitle.value = '新增裂缝'
  Object.assign(form, {
    ...EMPTY_CRACK_DRAFT,
    ringId: crackStore.filter.sectionId
      ? sectionStore.rings.find((ring) => ring.sectionId === crackStore.filter.sectionId)?.id ?? ''
      : ringOptions.value[0]?.value ?? ''
  })
  dialogVisible.value = true
}

function openEdit(crack: Crack): void {
  editingId = crack.id
  dialogTitle.value = `编辑裂缝 · ${crack.code}`
  Object.assign(form, {
    ringId: crack.ringId,
    code: crack.code,
    position: crack.position,
    direction: crack.direction,
    widthMm: crack.widthMm,
    lengthMm: crack.lengthMm,
    state: crack.state
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const instance = formRef.value
  if (!instance) return
  const valid = await instance.validate().catch(() => false)
  if (!valid) return
  if (editingId) {
    await crackStore.updateCrack(editingId, { ...form })
    ElMessage.success('裂缝档案已更新')
  } else {
    await crackStore.createCrack({ ...form })
    ElMessage.success('裂缝已建档，可前往复测对比页追加测次')
  }
  dialogVisible.value = false
}

async function remove(crack: Crack): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除裂缝「${crack.code}」将同时删除其复测记录与整治建议，确认删除？`,
    '删除确认',
    { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await crackStore.removeCrack(crack.id)
  ElMessage.success('裂缝及其下游数据已删除')
}

/* -------------------------- 批量与状态流转 -------------------------- */

const selectedRows = ref<CrackEnriched[]>([])
const bulkState = ref<CrackState>('待整治')

function onSelectionChange(rows: CrackEnriched[]): void {
  selectedRows.value = rows
  crackStore.setSelectedIds(rows.map((row) => row.crack.id))
}

async function applyBulkState(): Promise<void> {
  if (selectedRows.value.length === 0) {
    ElMessage.warning('请先勾选裂缝')
    return
  }
  await crackStore.bulkSetState(
    selectedRows.value.map((row) => row.crack.id),
    bulkState.value
  )
  ElMessage.success(`已将 ${selectedRows.value.length} 条裂缝置为「${bulkState.value}」`)
  selectedRows.value = []
}

const nextStateOf = (state: CrackState): CrackState | null => CRACK_STATE_FLOW[state]

async function advance(crack: Crack): Promise<void> {
  const next = nextStateOf(crack.state)
  if (!next) {
    ElMessage.info('该裂缝已完成整治，无需再流转')
    return
  }
  await crackStore.setState(crack.id, next)
  ElMessage.success(`${crack.code} 状态已推进为「${next}」`)
}

/* ------------------------------ 导出 ------------------------------ */

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

/* ------------------------------ 派生 ------------------------------ */

const rows = computed(() => crackStore.filtered)

const warningRows = computed(() => rows.value.filter((row) => row.level !== '一般'))

function rowClassName({ row }: { row: CrackEnriched }): string {
  return row.level === '严重' ? 'row-severe' : ''
}

function crackRowKey(row: CrackEnriched): string {
  return row.crack.id
}

function latestDateOf(crackId: string): string {
  return surveyStore.summaryOf(crackId)?.lastDate ?? '—'
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">裂缝初测录入</h2>
        <p class="page-head__desc">
          按环片登记裂缝部位、走向与初测尺寸；支持勾选批量改状态、单条状态流转与台账 CSV 导出。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button :icon="Download" @click="exportCsv">导出裂缝台账 CSV</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增裂缝</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="裂缝总数" :value="crackStore.cracks.length" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="待整治" :value="crackStore.waitingCount" suffix="条" icon="Histogram" tone="warning" />
      <StatBadge label="已整治" :value="crackStore.stateCounts['已整治']" suffix="条" icon="Grid" tone="success" />
      <StatBadge
        label="预警占比"
        :value="crackStore.warningCount"
        :percent="crackStore.cracks.length === 0 ? 0 : crackStore.warningPercent"
        icon="WarningFilled"
        tone="danger"
      />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索裂缝编号 / 环号 / 里程"
      @change="onFilterChange"
    >
      <template #actions>
        <el-select v-model="bulkState" style="width: 128px" size="default">
          <el-option v-for="item in crackStore.stateOptions" :key="item" :label="item" :value="item" />
        </el-select>
        <el-button type="primary" plain :icon="Refresh" @click="applyBulkState">
          批量改状态（{{ selectedRows.length }}）
        </el-button>
      </template>
    </FilterBar>

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title">裂缝清单（{{ rows.length }} / {{ crackStore.cracks.length }}）</h3>
        <span class="muted">预警裂缝 {{ warningRows.length }} 条，红色行表示速率已达严重级</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="没有匹配的裂缝"
        description="调整筛选条件，或先到区间台账录入环片，再新增裂缝。"
        action-text="新增裂缝"
        secondary-text="重置筛选"
        compact
        @action="openCreate"
        @secondary="crackStore.resetFilter()"
      />

      <el-table
        v-else
        :data="rows"
        :row-key="crackRowKey"
        border
        stripe
        :row-class-name="rowClassName"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="46" />
        <el-table-column label="裂缝编号" width="140">
          <template #default="{ row }">
            <strong>{{ row.crack.code }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="区间 / 里程" min-width="180">
          <template #default="{ row }">{{ row.sectionLabel }}</template>
        </el-table-column>
        <el-table-column label="环号" width="100">
          <template #default="{ row }">{{ row.ringLabel }}</template>
        </el-table-column>
        <el-table-column label="部位" width="86">
          <template #default="{ row }">{{ row.crack.position }}</template>
        </el-table-column>
        <el-table-column label="走向" width="86">
          <template #default="{ row }">{{ row.crack.direction }}</template>
        </el-table-column>
        <el-table-column label="当前宽度" width="110">
          <template #default="{ row }">{{ row.crack.widthMm.toFixed(2) }} mm</template>
        </el-table-column>
        <el-table-column label="当前长度" width="110">
          <template #default="{ row }">{{ row.crack.lengthMm }} mm</template>
        </el-table-column>
        <el-table-column label="测次" width="72">
          <template #default="{ row }">{{ row.surveyCount }}</template>
        </el-table-column>
        <el-table-column label="最近复测" width="112">
          <template #default="{ row }">{{ latestDateOf(row.crack.id) }}</template>
        </el-table-column>
        <el-table-column label="发展等级" width="170">
          <template #default="{ row }">
            <LevelTag :level="row.level" :rate="row.surveyCount > 1 ? row.rate : undefined" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.crack.state === '已整治' ? 'success' : row.crack.state === '待整治' ? 'warning' : 'info'"
            >
              {{ row.crack.state }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openEdit(row.crack)">
              <el-icon><Edit /></el-icon> 编辑
            </el-button>
            <el-button
              size="small"
              text
              type="primary"
              :disabled="!nextStateOf(row.crack.state)"
              @click="advance(row.crack)"
            >
              <el-icon><Right /></el-icon>
              {{ nextStateOf(row.crack.state) ? `转${nextStateOf(row.crack.state)}` : '已完成' }}
            </el-button>
            <el-button size="small" text type="danger" @click="remove(row.crack)">
              <el-icon><Delete /></el-icon> 删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="112px">
        <el-form-item label="所属环片" prop="ringId">
          <el-select v-model="form.ringId" filterable style="width: 100%" placeholder="选择区间下的环片">
            <el-option v-for="item in ringOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="裂缝编号" prop="code">
          <el-input v-model="form.code" placeholder="如 SL-118-01" />
        </el-form-item>
        <el-form-item label="结构部位" prop="position">
          <el-radio-group v-model="form.position">
            <el-radio-button v-for="item in crackStore.positionOptions" :key="item" :value="item">
              {{ item }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="裂缝走向" prop="direction">
          <el-radio-group v-model="form.direction">
            <el-radio-button v-for="item in crackStore.directionOptions" :key="item" :value="item">
              {{ item }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="初测宽度(mm)" prop="widthMm">
          <el-input-number v-model="form.widthMm" :min="0" :step="0.01" :precision="2" style="width: 100%" />
        </el-form-item>
        <el-form-item label="初测长度(mm)" prop="lengthMm">
          <el-input-number v-model="form.lengthMm" :min="0" :step="10" style="width: 100%" />
        </el-form-item>
        <el-form-item label="处置状态" prop="state">
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in crackStore.stateOptions" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-alert
          v-if="form.widthMm > 0.3"
          type="warning"
          :closable="false"
          title="初测宽度已超过 0.30 mm，登记后建议立即安排复测并生成整治建议。"
        />
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
  margin: 0;
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

:deep(.row-severe) {
  background: #fdecea !important;
}
</style>
