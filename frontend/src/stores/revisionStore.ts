/**
 * 修订链与审计核对状态（Pinia）
 * 维护修订记录订阅、全库核对报告与补链修复动作。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db } from '@/utils/db'
import {
  backfillMissingChains,
  repairEntityChain,
  revisionsOf
} from '@/utils/ledgerGateway'
import { buildAuditReport, type AuditIssue, type AuditReport } from '@/utils/audit'
import {
  ENTITY_TYPE_LABEL,
  REVISION_SOURCE,
  type RevisionEntityType,
  type RevisionRecord
} from '@/types/revision'

export const useRevisionStore = defineStore('revision', () => {
  const revisionTable = useIdbTable<RevisionRecord>((database) => database.revisions, {
    sortByUpdatedAt: false
  })

  const report = ref<AuditReport | null>(null)
  const scanning = ref(false)
  const repairing = ref(false)
  const lastError = ref<string | null>(null)

  const revisions = computed<RevisionRecord[]>(() =>
    [...revisionTable.rows.value].sort((a, b) => b.recordedAt - a.recordedAt)
  )

  /** 拉取全库数据并跑核对（纯读） */
  async function scan(): Promise<AuditReport> {
    scanning.value = true
    lastError.value = null
    try {
      const [sections, rings, cracks, surveys, advices, revisionRows] = await Promise.all([
        db.sections.toArray(),
        db.rings.toArray(),
        db.cracks.toArray(),
        db.surveys.toArray(),
        db.advices.toArray(),
        db.revisions.toArray()
      ])
      const result = buildAuditReport({ sections, rings, cracks, surveys, advices, revisions: revisionRows })
      report.value = result
      return result
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : '核对扫描失败'
      throw error
    } finally {
      scanning.value = false
    }
  }

  /** 修复单条「旧记录未建链」：按当时内容补初始链，成功后重扫 */
  async function repairIssue(issue: AuditIssue): Promise<void> {
    if (!issue.repairable) return
    repairing.value = true
    try {
      await repairEntityChain(issue.entityType, issue.entityId, {
        source: REVISION_SOURCE.auditBackfill,
        action: '审计核对页补初始链'
      })
      await scan()
    } finally {
      repairing.value = false
    }
  }

  /** 一键补全部未建链：事务失败回滚、自动重试；幂等，重复操作不多记 */
  async function repairAllUnchained(): Promise<{ created: number; skipped: number; failed: string[] }> {
    repairing.value = true
    try {
      const result = await backfillMissingChains({
        source: REVISION_SOURCE.auditBackfill,
        action: '审计核对页一键补初始链'
      })
      await scan()
      return { created: result.created, skipped: result.skipped, failed: result.failed }
    } finally {
      repairing.value = false
    }
  }

  function chainOf(entityType: RevisionEntityType, entityId: string): Promise<RevisionRecord[]> {
    return revisionsOf(entityType, entityId)
  }

  /** 某对象的修订条数（用于列表徽标） */
  function chainCountOf(entityType: RevisionEntityType, entityId: string): number {
    return revisionTable.rows.value.filter(
      (revision) => revision.entityType === entityType && revision.entityId === entityId
    ).length
  }

  return {
    revisionTable,
    revisions,
    report,
    scanning,
    repairing,
    lastError,
    entityTypeLabel: ENTITY_TYPE_LABEL,
    scan,
    repairIssue,
    repairAllUnchained,
    chainOf,
    chainCountOf
  }
})
