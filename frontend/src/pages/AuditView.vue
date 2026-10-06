<script setup lang="ts">
/**
 * /audit 修订链核对（审计抽查）
 * 扫描全库，逐对象核对「第一条摘要」与修订链连续性、台账当前内容，
 * 指出第一条摘要对不上的记录及关联对象，并区分：
 * - 内容缺失（missing-content）
 * - 链条断开（broken-chain）
 * - 旧记录未建链（unlinked-legacy）
 * 对未建链对象提供「按当时内容补初始链」：失败恢复到写入前状态并重试，重复操作不多记。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Connection, DocumentChecked, Refresh, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import RevisionDrawer from '@/components/common/RevisionDrawer.vue'
import {
  INTEGRITY_ISSUE_TEXT,
  REVISION_ENTITY_TEXT,
  type IntegrityIssue,
  type IntegrityIssueKind,
  type IntegrityReport,
  type RevisionEntityType
} from '@/types/revision'
import { backfillMissingChains, scanRevisionIntegrity } from '@/utils/revisionService'

const report = ref<IntegrityReport | null>(null)
const scanning = ref(false)
const backfilling = ref(false)
const lastBackfillNote = ref<string>('')

const drawerVisible = ref(false)
const drawerEntityType = ref<RevisionEntityType>('crack')
const drawerEntityId = ref('')
const drawerLabel = ref('')

async function runScan(): Promise<void> {
  scanning.value = true
  try {
    report.value = await scanRevisionIntegrity()
  } catch (error) {
    ElMessage.error(`核对扫描失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    scanning.value = false
  }
}

void runScan()

const issues = computed<IntegrityIssue[]>(() => report.value?.issues ?? [])

const countOfKind = (kind: IntegrityIssueKind): number =>
  issues.value.filter((issue) => issue.kind === kind).length

const healthy = computed(() => report.value !== null && issues.value.length === 0)

function issueTagType(kind: IntegrityIssueKind): 'danger' | 'warning' | 'info' {
  if (kind === 'missing-content') return 'danger'
  if (kind === 'broken-chain') return 'warning'
  return 'info'
}

function openChain(issue: IntegrityIssue): void {
  drawerEntityType.value = issue.entityType
  drawerEntityId.value = issue.entityId
  drawerLabel.value = issue.entityLabel
  drawerVisible.value = true
}

async function runBackfill(): Promise<void> {
  backfilling.value = true
  try {
    const result = await backfillMissingChains('审计补链')
    if (result.backfilled === 0) {
      ElMessage.info('没有需要补链的旧记录（重复操作不多记）')
    } else {
      ElMessage.success(
        `已按当时内容补建 ${result.backfilled} 条初始链${result.recovered ? '（首次写入失败，已恢复到写入前状态并重试成功）' : ''}`
      )
    }
    lastBackfillNote.value = result.recovered
      ? '补链过程中曾失败：已恢复到写入前状态并重试成功，未产生重复记录。'
      : result.backfilled > 0
        ? '补链完成：旧数据缺失字段按「缺失」入链，不算篡改。'
        : ''
    await runScan()
  } catch (error) {
    ElMessage.error(`补链失败（已恢复到写入前状态）：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    backfilling.value = false
  }
}

const scannedAtText = computed(() => {
  const ts = report.value?.scannedAt
  if (!ts) return ''
  const date = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
})
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">修订链核对（审计抽查）</h2>
        <p class="page-head__desc">
          扫描全库区间、环片、裂缝、复测测次与整治建议，核对每一条链的第一条摘要、链条连续性与台账当前值；
          现场台账与修订链分开保存，纠错只追加更正记录。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button :icon="Refresh" :loading="scanning" @click="runScan">重新扫描全库</el-button>
        <el-button type="primary" :icon="Connection" :loading="backfilling" @click="runBackfill">
          按当时内容补建缺失初始链
        </el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="业务对象" :value="report?.entityTotal ?? 0" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="已建链对象" :value="report?.linkedCount ?? 0" suffix="条" icon="Connection" tone="success" />
      <StatBadge label="修订记录" :value="report?.revisionCount ?? 0" suffix="条" icon="Tickets" tone="info" />
      <StatBadge label="核对异常" :value="issues.length" suffix="条" icon="WarningFilled" tone="danger" />
    </div>

    <div class="panel">
      <div class="panel-head">
        <h3 class="panel-title">核对结论</h3>
        <span class="muted">扫描时间：{{ scannedAtText || '—' }}</span>
      </div>

      <el-alert
        v-if="healthy"
        type="success"
        :closable="false"
        show-icon
        :icon="DocumentChecked"
        title="全部对象修订链完整：第一条摘要、链上衔接与台账当前内容均一致，未发现被动过的痕迹。"
        style="margin-bottom: 8px"
      />

      <el-alert
        v-if="issues.length > 0"
        type="warning"
        :closable="false"
        show-icon
        :icon="Warning"
        style="margin-bottom: 12px"
        :title="`发现 ${issues.length} 个对象的修订链对不上：旧记录未建链 ${countOfKind('unlinked-legacy')} 条、链条断开 ${countOfKind('broken-chain')} 条、内容缺失 ${countOfKind('missing-content')} 条。`"
        description="旧记录未建链可按当时内容补初始链（缺失字段不算篡改）；链条断开与内容缺失请先查看修订链核实，确认是现场直接覆盖旧值后再走纠错流程。"
      />

      <el-alert
        v-if="lastBackfillNote"
        type="info"
        :closable="false"
        show-icon
        :title="lastBackfillNote"
        style="margin-bottom: 12px"
      />

      <el-empty v-if="!scanning && issues.length === 0 && report" description="没有第一条摘要对不上的记录" />

      <el-table v-if="issues.length > 0" :data="issues" border stripe>
        <el-table-column label="对象类型" width="100">
          <template #default="{ row }">{{ REVISION_ENTITY_TEXT[row.entityType as RevisionEntityType] }}</template>
        </el-table-column>
        <el-table-column label="关联对象" min-width="220">
          <template #default="{ row }">
            <div><strong>{{ row.entityLabel }}</strong></div>
            <div class="muted">{{ row.relatedLabel || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="问题性质" width="130">
          <template #default="{ row }">
            <el-tag :type="issueTagType(row.kind as IntegrityIssueKind)" size="small">
              {{ INTEGRITY_ISSUE_TEXT[row.kind as IntegrityIssueKind] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="第一条对不上的记录与说明" min-width="320" show-overflow-tooltip />
        <el-table-column label="第一条摘要" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <span>{{ row.firstSummary || '（无任何修订记录）' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="链末/当前摘要" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">{{ row.lastSummary || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openChain(row)">查看修订链</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="panel">
      <h3 class="panel-title">核对口径</h3>
      <ul class="audit-rules">
        <li><el-tag size="small" type="info">旧记录未建链</el-tag> 台账中存在业务记录，但修订链一条都没有——属于升级前历史数据，可按当时内容补初始链。</li>
        <li><el-tag size="small" type="warning">链条断开</el-tag> 链上序号断裂、前一条指向错误，或某条登记的「前一条摘要」与上一条「当前摘要」对不上。</li>
        <li><el-tag size="small" type="danger">内容缺失</el-tag> 第一条摘要为空、链末摘要与台账当前内容对不上（疑似旧值被直接覆盖），或修订链在但业务行已缺失。</li>
        <li>旧数据升级补链只追加链首、不改业务值；当时缺失的字段以「缺失」入摘要，<strong>不算篡改</strong>。</li>
        <li>补链先备份写入前状态：写入失败会恢复到写入前状态并重试；已有链的对象一律跳过，重复操作不多记。</li>
      </ul>
    </div>

    <RevisionDrawer
      v-model="drawerVisible"
      :entity-type="drawerEntityType"
      :entity-id="drawerEntityId"
      :entity-label="drawerLabel"
    />
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

.muted {
  color: #8c99ab;
  font-size: 12px;
}

.audit-rules {
  margin: 0;
  padding-left: 0;
  list-style: none;
}

.audit-rules li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #5b6b82;
  line-height: 2;
}
</style>
