<script setup lang="ts">
/**
 * /audit 修订链核对（审计抽查）
 * 扫描全库，指出第一条摘要对不上的记录及关联对象，分类为：
 * 内容缺失 / 链条断开 / 旧记录未建链；未建链可按当时内容补初始链。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { DocumentChecked, Link, Refresh, View, WarningFilled, CircleCloseFilled, QuestionFilled } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useRevisionStore } from '@/stores/revisionStore'
import {
  AUDIT_ISSUE_LABEL,
  type AuditIssue,
  type AuditIssueKind
} from '@/utils/audit'
import {
  ENTITY_TYPE_LABEL,
  REVISION_KIND_LABEL,
  type RevisionEntityType,
  type RevisionRecord
} from '@/types/revision'

const revisionStore = useRevisionStore()

type FilterKind = AuditIssueKind | 'all'
const activeFilter = ref<FilterKind>('all')

onMounted(() => {
  void runScan()
})

async function runScan(): Promise<void> {
  try {
    await revisionStore.scan()
  } catch (error) {
    ElMessage.error(`核对扫描失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

const report = computed(() => revisionStore.report)

const visibleIssues = computed<AuditIssue[]>(() => {
  const list = report.value?.issues ?? []
  return activeFilter.value === 'all' ? list : list.filter((issue) => issue.issueKind === activeFilter.value)
})

const filterTabs = computed(() => [
  { key: 'all' as const, label: `全部 ${report.value?.issueCount ?? 0}` },
  { key: 'unchained' as const, label: `旧记录未建链 ${report.value?.issueCounts.unchained ?? 0}` },
  { key: 'broken' as const, label: `链条断开 ${report.value?.issueCounts.broken ?? 0}` },
  { key: 'missing' as const, label: `内容缺失 ${report.value?.issueCounts.missing ?? 0}` }
])

const issueMeta: Record<AuditIssueKind, { type: 'warning' | 'danger' | 'info'; icon: unknown }> = {
  unchained: { type: 'info', icon: Link },
  broken: { type: 'danger', icon: CircleCloseFilled },
  missing: { type: 'warning', icon: WarningFilled }
}

function issueTagType(kind: AuditIssueKind): 'info' | 'warning' | 'danger' {
  return issueMeta[kind].type
}

function scannedTime(ts: number): string {
  return formatTime(ts)
}

function formatTime(ts: number): string {
  if (!Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ------------------------------ 补链修复 ------------------------------ */

async function repair(issue: AuditIssue): Promise<void> {
  try {
    await revisionStore.repairIssue(issue)
    ElMessage.success(`已为「${issue.entityLabel}」按当时内容补初始链（缺失照实标注，不算篡改）`)
  } catch (error) {
    ElMessage.error(`补链失败，已回滚到写入前状态：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

async function repairAll(): Promise<void> {
  try {
    const result = await revisionStore.repairAllUnchained()
    if (result.failed.length > 0) {
      ElMessage.warning(`补链完成 ${result.created} 条，${result.failed.length} 条失败已回滚重试`)
    } else {
      ElMessage.success(`已按当时内容补建初始链 ${result.created} 条；重复对象 ${result.skipped} 条跳过，不多记`)
    }
  } catch (error) {
    ElMessage.error(`补链失败，已回滚到写入前状态并重试：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/* ------------------------------ 修订链抽屉 ------------------------------ */

const drawerVisible = ref(false)
const drawerTitle = ref('修订链')
const drawerChain = ref<RevisionRecord[]>([])
const drawerLoading = ref(false)

async function viewChain(issue: AuditIssue): Promise<void> {
  drawerTitle.value = `修订链 · ${ENTITY_TYPE_LABEL[issue.entityType]} ${issue.entityLabel}`
  drawerVisible.value = true
  drawerLoading.value = true
  drawerChain.value = []
  try {
    drawerChain.value = await revisionStore.chainOf(issue.entityType, issue.entityId)
  } finally {
    drawerLoading.value = false
  }
}

function kindTagType(kind: RevisionRecord['kind']): 'success' | 'primary' {
  return kind === 'initial' ? 'success' : 'primary'
}

function issueRowKey(row: AuditIssue): string {
  return row.key
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">修订链核对（审计抽查）</h2>
        <p class="page-head__desc">
          现场台账与修订链分离：每次写入记录来源、前一条摘要与当前摘要，纠错只追加更正记录、不盖旧值。
          本页扫描全库，指出第一条摘要对不上的记录及关联对象。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button type="primary" :icon="Refresh" :loading="revisionStore.scanning" @click="runScan">重新扫描全库</el-button>
        <el-button
          type="warning"
          plain
          :icon="Link"
          :loading="revisionStore.repairing"
          :disabled="(report?.issueCounts.unchained ?? 0) === 0"
          @click="repairAll"
        >
          一键补全部未建链
        </el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="台账对象总数" :value="report?.totalEntities ?? 0" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="已建链对象" :value="report?.chainedEntities ?? 0" suffix="条" icon="CircleCheckFilled" tone="success" />
      <StatBadge label="问题总数" :value="report?.issueCount ?? 0" suffix="处" icon="WarningFilled" tone="danger" />
      <StatBadge label="修订记录总数" :value="revisionStore.revisions.length" suffix="条" icon="DocumentChecked" tone="info" />
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="filter-tabs">
          <button
            v-for="tab in filterTabs"
            :key="tab.key"
            type="button"
            class="filter-tab"
            :class="{ 'is-active': activeFilter === tab.key }"
            @click="activeFilter = tab.key"
          >
            {{ tab.label }}
          </button>
        </div>
        <span class="muted">
          <el-icon><QuestionFilled /></el-icon>
          内容缺失＝旧记录缺字段（不算篡改）；链条断开＝摘要/指向对不上或疑似直接盖写；旧记录未建链＝可按当时内容补链
        </span>
      </div>

      <el-empty
        v-if="report && visibleIssues.length === 0"
        description="全部修订链核对一致：首条摘要、链条指向与台账当前值均可对上。"
      >
        <template #image>
          <el-icon :size="46" color="#1e8449"><DocumentChecked /></el-icon>
        </template>
      </el-empty>

      <el-table v-else :data="visibleIssues" border stripe :row-key="issueRowKey">
        <el-table-column label="问题分类" width="150">
          <template #default="{ row }">
            <el-tag :type="issueTagType(row.issueKind)" effect="dark">
              {{ AUDIT_ISSUE_LABEL[row.issueKind as AuditIssueKind] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对象" min-width="220">
          <template #default="{ row }">
            <div class="cell-strong">{{ ENTITY_TYPE_LABEL[row.entityType as RevisionEntityType] }} · {{ row.entityLabel }}</div>
            <div class="muted small">定位修订：{{ row.seq === null ? '无修订记录' : `第 ${row.seq} 条` }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="message" label="核对结论（第一条摘要对不上的说明）" min-width="360" show-overflow-tooltip />
        <el-table-column label="关联对象" min-width="240">
          <template #default="{ row }">
            <div v-for="ref in row.related.slice(1)" :key="`${ref.entityType}-${ref.entityId}`" class="related-line">
              <el-tag size="small" effect="plain">{{ ENTITY_TYPE_LABEL[ref.entityType as RevisionEntityType] }}</el-tag>
              <span class="related-label">{{ ref.label }}</span>
            </div>
            <span v-if="row.related.length <= 1" class="muted small">无上级关联对象</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" :icon="View" @click="viewChain(row)">查看修订链</el-button>
            <el-button
              v-if="row.repairable"
              size="small"
              text
              type="warning"
              :icon="Link"
              :loading="revisionStore.repairing"
              @click="repair(row)"
            >
              补初始链
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <p v-if="report" class="muted small scan-foot">
        最近扫描时间：{{ scannedTime(report.scannedAt) }}
        · 扫描口径：首条必须为初始记录（prevId/prevSummary 为空），各条「前一条摘要」须与上一条当前摘要逐字一致，末次摘要须等于台账当前值。
      </p>
    </div>

    <el-drawer v-model="drawerVisible" :title="drawerTitle" size="560px">
      <div v-loading="drawerLoading">
        <el-empty v-if="!drawerLoading && drawerChain.length === 0" description="该对象尚无修订链（旧记录未建链）。" />
        <el-timeline v-else>
          <el-timeline-item
            v-for="revision in drawerChain"
            :key="revision.id"
            :type="revision.kind === 'initial' ? 'success' : 'primary'"
            :timestamp="formatTime(revision.recordedAt)"
            placement="top"
          >
            <div class="rev-card">
              <div class="rev-card__head">
                <el-tag size="small" :type="kindTagType(revision.kind)">
                  第 {{ revision.seq }} 条 · {{ REVISION_KIND_LABEL[revision.kind] }}
                </el-tag>
                <el-tag size="small" effect="plain">{{ revision.action }}</el-tag>
              </div>
              <div class="rev-line"><span class="rev-k">来源</span><span class="rev-v">{{ revision.source }}</span></div>
              <div class="rev-line">
                <span class="rev-k">前一条摘要</span>
                <span class="rev-v" :class="{ 'muted': revision.prevSummary === null }">
                  {{ revision.prevSummary ?? '（链首，无前一条）' }}
                </span>
              </div>
              <div class="rev-line"><span class="rev-k">当前摘要</span><span class="rev-v">{{ revision.summary }}</span></div>
              <div v-if="revision.changedSummary" class="rev-line">
                <span class="rev-k">本次变化</span><span class="rev-v changed">{{ revision.changedSummary }}</span>
              </div>
            </div>
          </el-timeline-item>
        </el-timeline>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.filter-tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.filter-tab {
  border: 1px solid var(--el-border-color, #dcdfe6);
  background: var(--el-fill-color-blank, #fff);
  border-radius: 999px;
  padding: 5px 14px;
  font-size: 13px;
  cursor: pointer;
  color: var(--el-text-color-regular, #606266);
  transition: all 0.15s ease;
}

.filter-tab.is-active {
  background: var(--el-color-primary, #409eff);
  border-color: var(--el-color-primary, #409eff);
  color: #fff;
}

.cell-strong {
  font-weight: 600;
}

.related-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
}

.related-label {
  font-size: 12px;
  color: var(--el-text-color-regular, #606266);
}

.small {
  font-size: 12px;
}

.scan-foot {
  margin-top: 12px;
  line-height: 1.7;
}

.rev-card {
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--el-fill-color-light, #fafafa);
}

.rev-card__head {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.rev-line {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 13px;
  line-height: 1.7;
}

.rev-k {
  flex: 0 0 72px;
  color: var(--el-text-color-secondary, #909399);
}

.rev-v {
  flex: 1;
  word-break: break-all;
}

.rev-v.changed {
  color: var(--el-color-danger, #c0392b);
  font-weight: 600;
}
</style>
