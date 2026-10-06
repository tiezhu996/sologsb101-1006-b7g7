/**
 * 修订链核对（纯函数）
 *
 * 扫描全库所有业务对象的修订链，指出「第一条摘要对不上」的记录及其关联对象，
 * 并把问题归入三类：
 *  - missing   内容缺失：旧记录缺字段，初始/末次摘要无法与当时内容对应（缺失不算篡改）
 *  - broken    链条断开：有序号断档、prevId/prevSummary 对不上、首条不是初始记录、
 *                       末次摘要与台账当前值不一致（疑似直接盖写，未追加更正记录）
 *  - unchained 旧记录未建链：台账里有对象，但一条修订记录都没有（可按当时内容补初始链）
 */
import type { Section } from '@/types/section'
import type { Ring } from '@/types/ring'
import type { Crack } from '@/types/crack'
import type { Survey } from '@/types/survey'
import type { Advice } from '@/types/advice'
import { formatMileage } from '@/types/section'
import {
  ENTITY_TYPE_LABEL,
  type RevisionEntityType,
  type RevisionRecord
} from '@/types/revision'
import { MISSING_TEXT, summaryOf, trackedSnapshot } from '@/utils/ledgerSummary'

export type AuditIssueKind = 'missing' | 'broken' | 'unchained'

export const AUDIT_ISSUE_LABEL: Record<AuditIssueKind, string> = {
  missing: '内容缺失',
  broken: '链条断开',
  unchained: '旧记录未建链'
}

/** 关联对象引用（链路定位：测次 → 裂缝 → 环片 → 区间） */
export interface RelatedRef {
  entityType: RevisionEntityType
  entityId: string
  label: string
}

export interface AuditIssue {
  /** 稳定去重键 */
  key: string
  entityType: RevisionEntityType
  entityId: string
  /** 对象自身标签，如「裂缝 SL-118-01」 */
  entityLabel: string
  issueKind: AuditIssueKind
  /** 问题定位到的修订序号（未建链时为空） */
  seq: number | null
  revisionId: string | null
  message: string
  /** 关联对象清单（含自身，按链路顺序） */
  related: RelatedRef[]
  /** 仅「旧记录未建链」可按当时内容补初始链 */
  repairable: boolean
}

export interface AuditDataset {
  sections: Section[]
  rings: Ring[]
  cracks: Crack[]
  surveys: Survey[]
  advices: Advice[]
  revisions: RevisionRecord[]
}

export interface AuditReport {
  scannedAt: number
  totalEntities: number
  chainedEntities: number
  issueCount: number
  issueCounts: Record<AuditIssueKind, number>
  issues: AuditIssue[]
}

/* ------------------------------ 对象标签 ------------------------------ */

type RowMap = {
  section: Map<string, Section>
  ring: Map<string, Ring>
  crack: Map<string, Crack>
  survey: Map<string, Survey>
  advice: Map<string, Advice>
}

function buildMaps(data: AuditDataset): RowMap {
  return {
    section: new Map(data.sections.map((row) => [row.id, row])),
    ring: new Map(data.rings.map((row) => [row.id, row])),
    crack: new Map(data.cracks.map((row) => [row.id, row])),
    survey: new Map(data.surveys.map((row) => [row.id, row])),
    advice: new Map(data.advices.map((row) => [row.id, row]))
  }
}

/** 对象自身标签（关联对象缺失时显式标注，不阻断核对） */
export function entitySelfLabel(type: RevisionEntityType, row: Record<string, unknown>): string {
  const prefix = ENTITY_TYPE_LABEL[type]
  switch (type) {
    case 'section':
      return `${prefix} ${String(row.line ?? MISSING_TEXT)} ${
        typeof row.startMileage === 'number' ? formatMileage(row.startMileage) : MISSING_TEXT
      }~${typeof row.endMileage === 'number' ? formatMileage(row.endMileage) : MISSING_TEXT}`
    case 'ring':
      return `${prefix} 第${typeof row.ringNo === 'number' ? row.ringNo : MISSING_TEXT}环（${
        typeof row.mileage === 'number' ? formatMileage(row.mileage) : MISSING_TEXT
      }）`
    case 'crack':
      return `${prefix} ${String(row.code ?? MISSING_TEXT)}`
    case 'survey':
      return `${prefix} 第${typeof row.seq === 'number' ? row.seq : MISSING_TEXT}测次（${String(
        row.date ?? MISSING_TEXT
      )}）`
    case 'advice':
      return `${prefix} ${String(row.measure ?? MISSING_TEXT)}（${String(row.level ?? MISSING_TEXT)}）`
  }
}

/** 关联对象链：裂缝→环片→区间；测次/建议→裂缝→环片→区间 */
export function relatedRefsOf(
  type: RevisionEntityType,
  row: Record<string, unknown>,
  maps: RowMap
): RelatedRef[] {
  const refs: Array<{ type: RevisionEntityType; id: unknown }> = []
  const push = (refType: RevisionEntityType, id: unknown): void => {
    if (typeof id === 'string' && id.length > 0) refs.push({ type: refType, id })
  }

  if (type === 'ring') push('section', row.sectionId)
  if (type === 'crack') {
    push('ring', row.ringId)
    const ring = maps.ring.get(String(row.ringId))
    if (ring) push('section', ring.sectionId)
  }
  if (type === 'survey' || type === 'advice') {
    push('crack', row.crackId)
    const crack = maps.crack.get(String(row.crackId))
    if (crack) {
      push('ring', crack.ringId)
      const ring = maps.ring.get(crack.ringId)
      if (ring) push('section', ring.sectionId)
    }
  }

  const related: RelatedRef[] = []
  refs.forEach(({ type: refType, id }) => {
    const refRow = maps[refType].get(String(id))
    related.push({
      entityType: refType,
      entityId: String(id),
      label: refRow
        ? entitySelfLabel(refType, refRow as unknown as Record<string, unknown>)
        : `${ENTITY_TYPE_LABEL[refType]}已删除（${String(id)}）`
    })
  })
  return related
}

/* ------------------------------ 扫描核对 ------------------------------ */

const ALL_TYPES: RevisionEntityType[] = ['section', 'ring', 'crack', 'survey', 'advice']

function rowsOfType(data: AuditDataset, type: RevisionEntityType): Array<Record<string, unknown>> {
  switch (type) {
    case 'section':
      return data.sections as unknown as Array<Record<string, unknown>>
    case 'ring':
      return data.rings as unknown as Array<Record<string, unknown>>
    case 'crack':
      return data.cracks as unknown as Array<Record<string, unknown>>
    case 'survey':
      return data.surveys as unknown as Array<Record<string, unknown>>
    case 'advice':
      return data.advices as unknown as Array<Record<string, unknown>>
  }
}

function missingFieldKeys(snapshot: Record<string, unknown>): string[] {
  return Object.entries(snapshot)
    .filter(([, value]) => value === null || value === undefined || value === '')
    .map(([key]) => key)
}

/**
 * 扫描全库，产出核对报告（纯读操作，不修复任何数据）。
 */
export function buildAuditReport(data: AuditDataset): AuditReport {
  const maps = buildMaps(data)
  const issues: AuditIssue[] = []

  // entityType|entityId → 链记录（按 seq 升序）
  const chains = new Map<string, RevisionRecord[]>()
  data.revisions.forEach((revision) => {
    const key = `${revision.entityType}|${revision.entityId}`
    const list = chains.get(key)
    if (list) list.push(revision)
    else chains.set(key, [revision])
  })
  chains.forEach((list) => list.sort((a, b) => a.seq - b.seq || a.recordedAt - b.recordedAt))

  let totalEntities = 0
  let chainedEntities = 0

  ALL_TYPES.forEach((type) => {
    rowsOfType(data, type).forEach((row) => {
      totalEntities += 1
      const entityId = String(row.id)
      const selfLabel = entitySelfLabel(type, row)
      const relatedBase: RelatedRef[] = [{ entityType: type, entityId, label: selfLabel }]
      const chain = chains.get(`${type}|${entityId}`) ?? []

      const pushIssue = (
        issueKind: AuditIssueKind,
        seq: number | null,
        revisionId: string | null,
        message: string,
        repairable = false
      ): void => {
        issues.push({
          key: `${type}|${entityId}|${issueKind}|${seq ?? 0}|${revisionId ?? 'live'}`,
          entityType: type,
          entityId,
          entityLabel: selfLabel,
          issueKind,
          seq,
          revisionId,
          message,
          related: [...relatedBase, ...relatedRefsOf(type, row, maps)],
          repairable
        })
      }

      if (chain.length === 0) {
        // 旧记录未建链：可按当时内容补初始链（缺失字段照实标注，不算篡改）
        pushIssue('unchained', null, null, '台账有记录但修订链为空：旧记录未建立修订链，可按当时内容补初始链。', true)
        return
      }

      chainedEntities += 1
      const liveSnapshot = trackedSnapshot(type, row)
      const liveSummary = summaryOf(type, liveSnapshot)
      const liveMissing = missingFieldKeys(liveSnapshot)

      chain.forEach((revision, index) => {
        const expectedSeq = index + 1
        const previous = index === 0 ? null : chain[index - 1]
        const recomputed = summaryOf(type, revision.snapshot ?? {})
        const snapshotMissing = missingFieldKeys(revision.snapshot ?? {})

        // 1) 链内结构：序号、prevId、prevSummary、首条性质
        if (index === 0) {
          if (revision.seq !== 1) {
            pushIssue('broken', revision.seq, revision.id, `首条修订序号应为 1，实际为第 ${revision.seq} 条：链条断开。`)
          }
          if (revision.kind !== 'initial' || revision.prevId !== null || revision.prevSummary !== null) {
            pushIssue(
              'broken',
              revision.seq,
              revision.id,
              '首条不是初始记录（kind/prevId/prevSummary 不满足链首条件）：第一条摘要对不上。'
            )
          }
        } else if (revision.seq !== expectedSeq) {
          pushIssue('broken', revision.seq, revision.id, `修订序号不连续：期望第 ${expectedSeq} 条，实际为第 ${revision.seq} 条：链条断开。`)
        } else if (previous && revision.prevId !== previous.id) {
          pushIssue(
            'broken',
            revision.seq,
            revision.id,
            `第 ${revision.seq} 条 prevId 未指向上一条（第 ${previous.seq} 条）：链条断开。`
          )
        } else if (previous && revision.prevSummary !== previous.summary) {
          pushIssue(
            'broken',
            revision.seq,
            revision.id,
            `第 ${revision.seq} 条记录的「前一条摘要」与第 ${previous.seq} 条的当前摘要不一致：链条断开（上一条疑似被就地改写）。`
          )
        }

        // 2) 本条摘要与自身快照复算是否一致
        if (revision.summary !== recomputed) {
          if (snapshotMissing.length > 0) {
            pushIssue(
              'missing',
              revision.seq,
              revision.id,
              `第 ${revision.seq} 条摘要与当时内容对不上：快照缺字段 ${snapshotMissing.join('、')}（旧数据缺失，不算篡改）。`
            )
          } else {
            pushIssue(
              'broken',
              revision.seq,
              revision.id,
              `第 ${revision.seq} 条摘要与其内容快照复算结果不一致：链条锚点被破坏，疑似发生过非追加式改写。`
            )
          }
        }
      })

      // 3) 台账当前内容本身缺字段：内容缺失（旧数据缺失，不算篡改），单列一条
      const last = chain[chain.length - 1]
      if (liveMissing.length > 0) {
        pushIssue(
          'missing',
          last.seq,
          last.id,
          `台账当前内容缺字段 ${liveMissing.join('、')}（旧数据缺失，不算篡改），相关摘要以「${MISSING_TEXT}」标注。`
        )
      } else if (last.summary !== liveSummary) {
        // 4) 字段齐全时末次摘要必须与台账当前值一致，否则现场值被直接盖写
        pushIssue(
          'broken',
          last.seq,
          last.id,
          '末次修订的当前摘要与台账当前值不一致：现场纠错疑似直接盖写旧值，未追加更正记录。'
        )
      }
    })
  })

  // 4) 孤立修订（对象已不存在）：级联删除本应清掉，残留即链断
  const seen = new Set<string>()
  data.revisions.forEach((revision) => {
    if (seen.has(revision.id)) return
    seen.add(revision.id)
    const liveRow = maps[revision.entityType].get(revision.entityId)
    if (!liveRow) {
      issues.push({
        key: `orphan|${revision.entityType}|${revision.entityId}|${revision.id}`,
        entityType: revision.entityType,
        entityId: revision.entityId,
        entityLabel: `${ENTITY_TYPE_LABEL[revision.entityType]}已删除（${revision.entityId}）`,
        issueKind: 'broken',
        seq: revision.seq,
        revisionId: revision.id,
        message: '修订记录存在但台账对象已缺失：链路悬空（孤立修订）。',
        related: [
          {
            entityType: revision.entityType,
            entityId: revision.entityId,
            label: `${ENTITY_TYPE_LABEL[revision.entityType]}已删除（${revision.entityId}）`
          }
        ],
        repairable: false
      })
    }
  })

  const order: Record<AuditIssueKind, number> = { unchained: 0, broken: 1, missing: 2 }
  issues.sort((a, b) => order[a.issueKind] - order[b.issueKind] || (a.seq ?? 0) - (b.seq ?? 0))

  const issueCounts: Record<AuditIssueKind, number> = { missing: 0, broken: 0, unchained: 0 }
  issues.forEach((issue) => {
    issueCounts[issue.issueKind] += 1
  })

  return {
    scannedAt: Date.now(),
    totalEntities,
    chainedEntities,
    issueCount: issues.length,
    issueCounts,
    issues
  }
}
