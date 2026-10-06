<script setup lang="ts">
/**
 * /sections 区间与环片里程台账
 * 新建区间与环片、按线路与结构型式筛选、里程区间二维筛选、展开该环全部裂缝。
 * 消费 Section、Ring；复用 <StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Edit, Files, Grid, Plus, TrendCharts } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useSectionStore, type RingEnriched } from '@/stores/sectionStore'
import { useCrackStore } from '@/stores/crackStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { EMPTY_RING_DRAFT, type Ring, type RingDraft } from '@/types/ring'
import { EMPTY_SECTION_DRAFT, formatMileage, type Section, type SectionDraft, type StructureType } from '@/types/section'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const router = useRouter()
const sectionStore = useSectionStore()
const crackStore = useCrackStore()
const surveyStore = useSurveyStore()

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: sectionStore.keyword,
  structureType: sectionStore.structureTypes
}))

const filterSelects = computed(() => [
  {
    key: 'structureType',
    label: '结构型式',
    options: sectionStore.structureTypeOptions.map((item) => ({ label: item, value: item }))
  }
])

function onFilterChange(model: FilterModel): void {
  sectionStore.keyword = String(model.keyword ?? '')
  const raw = model.structureType
  const values = Array.isArray(raw) ? raw : []
  sectionStore.setStructureTypes(values as StructureType[])
}

/* ---------------------------- 区间表单 ---------------------------- */

const sectionDialogVisible = ref(false)
const sectionDialogTitle = ref('新建区间')
const sectionFormRef = ref<FormInstance>()
const sectionForm = reactive<SectionDraft>({ ...EMPTY_SECTION_DRAFT })
let editingSectionId: string | null = null

const sectionRules: FormRules = {
  line: [{ required: true, message: '请填写线路名称', trigger: 'blur' }],
  startMileage: [{ required: true, message: '请填写起始里程（m）', trigger: 'blur' }],
  endMileage: [
    { required: true, message: '请填写终止里程（m）', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (Number(value) <= Number(sectionForm.startMileage)) callback(new Error('终止里程必须大于起始里程'))
        else callback()
      },
      trigger: 'blur'
    }
  ]
}

function openCreateSection(): void {
  editingSectionId = null
  sectionDialogTitle.value = '新建区间'
  Object.assign(sectionForm, EMPTY_SECTION_DRAFT)
  sectionDialogVisible.value = true
}

function openEditSection(section: Section): void {
  editingSectionId = section.id
  sectionDialogTitle.value = `编辑区间 · ${section.line}`
  Object.assign(sectionForm, {
    line: section.line,
    startMileage: section.startMileage,
    endMileage: section.endMileage,
    structureType: section.structureType,
    ringCount: section.ringCount
  })
  sectionDialogVisible.value = true
}

async function submitSection(): Promise<void> {
  const form = sectionFormRef.value
  if (!form) return
  const valid = await form.validate().catch(() => false)
  if (!valid) return
  if (editingSectionId) {
    await sectionStore.updateSection(editingSectionId, { ...sectionForm })
    ElMessage.success('区间已更新')
  } else {
    await sectionStore.createSection({ ...sectionForm })
    ElMessage.success('区间已创建，可继续录入环片里程')
  }
  sectionDialogVisible.value = false
}

async function removeSection(section: Section): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除区间「${section.line} ${formatMileage(section.startMileage)}～${formatMileage(section.endMileage)}」将同时删除其下全部环片、裂缝、复测与建议，确认删除？`,
    '删除确认',
    { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await sectionStore.removeSection(section.id)
  ElMessage.success('区间及其下游数据已删除')
}

/* ---------------------------- 环片表单 ---------------------------- */

const ringDialogVisible = ref(false)
const ringDialogTitle = ref('新建环片')
const ringFormRef = ref<FormInstance>()
const ringForm = reactive<RingDraft>({ ...EMPTY_RING_DRAFT })
let editingRingId: string | null = null

const ringRules: FormRules = {
  ringNo: [{ required: true, message: '请填写环号', trigger: 'blur' }],
  mileage: [{ required: true, message: '请填写里程（m）', trigger: 'blur' }],
  installDate: [{ required: true, message: '请选择安装日期', trigger: 'change' }]
}

function openCreateRing(): void {
  if (!sectionStore.currentSectionId) {
    ElMessage.warning('请先选择或新建一个区间')
    return
  }
  editingRingId = null
  ringDialogTitle.value = `新建环片 · ${sectionStore.currentSection?.line ?? ''}`
  Object.assign(ringForm, { ...EMPTY_RING_DRAFT, sectionId: sectionStore.currentSectionId })
  ringDialogVisible.value = true
}

function openEditRing(ring: Ring): void {
  editingRingId = ring.id
  ringDialogTitle.value = `编辑环片 · 第 ${ring.ringNo} 环`
  Object.assign(ringForm, {
    sectionId: ring.sectionId,
    ringNo: ring.ringNo,
    mileage: ring.mileage,
    segmentType: ring.segmentType,
    installDate: ring.installDate
  })
  ringDialogVisible.value = true
}

async function submitRing(): Promise<void> {
  const form = ringFormRef.value
  if (!form) return
  const valid = await form.validate().catch(() => false)
  if (!valid) return
  if (editingRingId) {
    await sectionStore.updateRing(editingRingId, { ...ringForm })
    ElMessage.success('环片已更新')
  } else {
    await sectionStore.createRing({ ...ringForm })
    ElMessage.success('环片已录入')
  }
  ringDialogVisible.value = false
}

async function removeRing(ring: Ring): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除第 ${ring.ringNo} 环将同时删除该环的裂缝与复测记录，确认删除？`,
    '删除确认',
    { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await sectionStore.removeRing(ring.id)
  ElMessage.success('环片及其下游数据已删除')
}

/* ---------------------------- 派生展示 ---------------------------- */

function cracksOfRing(ringId: string) {
  return crackStore.cracks.filter((crack) => crack.ringId === ringId)
}

function statOf(sectionId: string): { crackCount: number; warningCount: number } {
  return crackStore.sectionStats[sectionId] ?? { crackCount: 0, warningCount: 0 }
}

function rateOf(crackId: string): number {
  return surveyStore.rateMap[crackId] ?? 0
}

function goCrackEntry(sectionId: string): void {
  crackStore.patchFilter({ sectionId, keyword: '', lines: [], positions: [], directions: [], states: [] })
  void router.push('/cracks')
}

const mileageInput = reactive<{ from: number | null; to: number | null }>({
  from: sectionStore.mileageFrom,
  to: sectionStore.mileageTo
})

watch(
  () => [sectionStore.mileageFrom, sectionStore.mileageTo] as const,
  ([from, to]) => {
    mileageInput.from = from
    mileageInput.to = to
  }
)

function onMileageChange(): void {
  sectionStore.setMileageRange(mileageInput.from, mileageInput.to)
}

function ringRowKey(row: RingEnriched): string {
  return row.ring.id
}

const totalCracks = computed(() => crackStore.cracks.length)
const totalRings = computed(() => sectionStore.rings.length)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">区间与环片里程台账</h2>
        <p class="page-head__desc">
          先建区间再录环片里程；卡片回显裂缝总数与预警数，点击卡片切换右侧环片明细。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button type="primary" :icon="Plus" @click="openCreateSection">新建区间</el-button>
        <el-button :icon="Grid" :disabled="!sectionStore.currentSectionId" @click="openCreateRing">录入环片</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="区间总数" :value="sectionStore.sections.length" suffix="个" icon="Files" tone="primary" />
      <StatBadge label="环片总数" :value="totalRings" suffix="环" icon="Grid" tone="info" />
      <StatBadge label="裂缝总数" :value="totalCracks" suffix="条" icon="Histogram" tone="default" />
      <StatBadge
        label="预警占比"
        :value="crackStore.warningCount"
        :percent="totalCracks === 0 ? 0 : crackStore.warningPercent"
        icon="WarningFilled"
        tone="danger"
      />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索线路或里程（K12+300）"
      @change="onFilterChange"
    />

    <div class="grid-two" style="margin-top: 16px">
      <div class="panel">
        <h3 class="panel-title">区间列表</h3>
        <EmptyPanel
          v-if="sectionStore.filteredSections.length === 0"
          title="还没有区间"
          description="新建一个区间后即可录入环片里程与裂缝档案。"
          action-text="新建区间"
          compact
          @action="openCreateSection"
        />
        <div
          v-for="section in sectionStore.filteredSections"
          :key="section.id"
          class="section-card"
          :class="{ 'is-active': section.id === sectionStore.currentSectionId }"
          @click="sectionStore.selectSection(section.id)"
        >
          <div class="section-card__head">
            <span class="section-card__title">{{ section.line }}</span>
            <el-tag size="small" effect="plain">{{ section.structureType }}</el-tag>
          </div>
          <div class="section-card__meta">
            <span>{{ formatMileage(section.startMileage) }} ～ {{ formatMileage(section.endMileage) }}</span>
            <span>· {{ section.ringCount }} 环</span>
            <span>· 裂缝 {{ statOf(section.id).crackCount }}</span>
            <span :style="{ color: statOf(section.id).warningCount > 0 ? '#c0392b' : undefined }">
              · 预警 {{ statOf(section.id).warningCount }}
            </span>
          </div>
          <div class="section-card__meta" style="margin-top: 8px; gap: 8px">
            <el-button size="small" text type="primary" @click.stop="openEditSection(section)">
              <el-icon><Edit /></el-icon> 编辑
            </el-button>
            <el-button size="small" text type="danger" @click.stop="removeSection(section)">
              <el-icon><Delete /></el-icon> 删除
            </el-button>
            <el-button size="small" text type="primary" @click.stop="goCrackEntry(section.id)">
              <el-icon><Files /></el-icon> 该区间裂缝
            </el-button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3 class="panel-title">
            环片明细
            <span v-if="sectionStore.currentSection" class="muted">· {{ sectionStore.currentSection.line }}</span>
          </h3>
          <div class="panel-head__filter">
            <el-input-number
              v-model="mileageInput.from"
              :min="0"
              :controls="false"
              placeholder="里程起"
              style="width: 118px"
              @change="onMileageChange"
            />
            <span class="muted">～</span>
            <el-input-number
              v-model="mileageInput.to"
              :min="0"
              :controls="false"
              placeholder="里程止"
              style="width: 118px"
              @change="onMileageChange"
            />
            <el-button size="small" :icon="TrendCharts" @click="sectionStore.setMileageRange(null, null)">清除里程</el-button>
          </div>
        </div>

        <EmptyPanel
          v-if="sectionStore.filteredRings.length === 0"
          title="该区间暂无环片"
          description="按里程录入环片后，可在展开行查看每一环的裂缝明细。"
          action-text="录入环片"
          secondary-text="清除筛选"
          compact
          @action="openCreateRing"
          @secondary="sectionStore.resetFilter()"
        />

        <el-table v-else :data="sectionStore.filteredRings" :row-key="ringRowKey" border stripe>
          <el-table-column type="expand">
            <template #default="{ row }">
              <div style="padding: 8px 16px">
                <div class="muted" style="margin-bottom: 6px">
                  第 {{ row.ring.ringNo }} 环共 {{ cracksOfRing(row.ring.id).length }} 条裂缝
                </div>
                <el-table :data="cracksOfRing(row.ring.id)" size="small" border>
                  <el-table-column prop="code" label="裂缝编号" width="140" />
                  <el-table-column prop="position" label="部位" width="90" />
                  <el-table-column prop="direction" label="走向" width="90" />
                  <el-table-column label="当前宽度" width="120">
                    <template #default="{ row: crack }">{{ crack.widthMm.toFixed(2) }} mm</template>
                  </el-table-column>
                  <el-table-column label="月均速率" width="130">
                    <template #default="{ row: crack }">{{ rateOf(crack.id).toFixed(3) }} mm/月</template>
                  </el-table-column>
                  <el-table-column label="状态" width="100">
                    <template #default="{ row: crack }">
                      <el-tag
                        size="small"
                        :type="crack.state === '已整治' ? 'success' : crack.state === '待整治' ? 'warning' : 'info'"
                      >
                        {{ crack.state }}
                      </el-tag>
                    </template>
                  </el-table-column>
                  <template #empty>
                    <span class="muted">该环暂未登记裂缝</span>
                  </template>
                </el-table>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="环号" width="100">
            <template #default="{ row }">第 {{ row.ring.ringNo }} 环</template>
          </el-table-column>
          <el-table-column label="里程" width="120">
            <template #default="{ row }">{{ row.mileageText }}</template>
          </el-table-column>
          <el-table-column label="管片类型" width="130">
            <template #default="{ row }">{{ row.ring.segmentType }}</template>
          </el-table-column>
          <el-table-column prop="ring.installDate" label="安装日期" width="130" />
          <el-table-column label="裂缝数" width="90">
            <template #default="{ row }">{{ cracksOfRing(row.ring.id).length }}</template>
          </el-table-column>
          <el-table-column label="操作" min-width="200" fixed="right">
            <template #default="{ row }">
              <el-button size="small" text type="primary" @click="openEditRing(row.ring)">编辑</el-button>
              <el-button size="small" text type="danger" @click="removeRing(row.ring)">删除</el-button>
              <el-button size="small" text type="primary" @click="goCrackEntry(row.ring.sectionId)">裂缝台账</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <el-dialog v-model="sectionDialogVisible" :title="sectionDialogTitle" width="520px">
      <el-form ref="sectionFormRef" :model="sectionForm" :rules="sectionRules" label-width="110px">
        <el-form-item label="线路名称" prop="line">
          <el-input v-model="sectionForm.line" placeholder="如 1号线" />
        </el-form-item>
        <el-form-item label="起始里程(m)" prop="startMileage">
          <el-input-number v-model="sectionForm.startMileage" :min="0" :step="50" style="width: 100%" />
        </el-form-item>
        <el-form-item label="终止里程(m)" prop="endMileage">
          <el-input-number v-model="sectionForm.endMileage" :min="0" :step="50" style="width: 100%" />
        </el-form-item>
        <el-form-item label="结构型式" prop="structureType">
          <el-select v-model="sectionForm.structureType" style="width: 100%">
            <el-option v-for="item in sectionStore.structureTypeOptions" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="环数" prop="ringCount">
          <el-input-number v-model="sectionForm.ringCount" :min="0" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="sectionDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitSection">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="ringDialogVisible" :title="ringDialogTitle" width="520px">
      <el-form ref="ringFormRef" :model="ringForm" :rules="ringRules" label-width="110px">
        <el-form-item label="所属区间">
          <el-input :model-value="sectionStore.currentSection ? sectionStore.currentSection.line : ''" disabled />
        </el-form-item>
        <el-form-item label="环号" prop="ringNo">
          <el-input-number v-model="ringForm.ringNo" :min="1" style="width: 100%" />
        </el-form-item>
        <el-form-item label="里程(m)" prop="mileage">
          <el-input-number v-model="ringForm.mileage" :min="0" :step="1" style="width: 100%" />
        </el-form-item>
        <el-form-item label="管片类型" prop="segmentType">
          <el-select v-model="ringForm.segmentType" style="width: 100%">
            <el-option v-for="item in sectionStore.segmentTypeOptions" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="安装日期" prop="installDate">
          <el-date-picker v-model="ringForm.installDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ringDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitRing">保存</el-button>
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
  gap: 12px;
}

.panel-head__filter {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
