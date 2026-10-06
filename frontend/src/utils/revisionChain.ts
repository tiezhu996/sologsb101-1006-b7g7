/**
 * 修订链构造助手（纯函数 + 类型映射），不持有 Dexie 实例：
 * db.ts（升级 / 播种 / 导入 / 级联删除）与 revisionService.ts（页面写入）共用，
 * 避免「db ↔ service」循环依赖。
 */
import type { Section } from '@/types/section'
import type { Ring } from '@/types/ring'
import type { Crack } from '@/types/crack'
import type { Survey } from '@/types/survey'
import type { Advice } from '@/types/advice'
import { createId } from '@/utils/id'
import {
  DEFAULT_OPERATOR,
  REVISION_SOURCES,
  TOMBSTONE_SUMMARY,
  type Revision,
  type RevisionAction,
  type RevisionEntityType,
  type RevisionFieldChange
} from '@/types/revision'
import { businessLabel, diffRows, summarizeRow, type BusinessRow } from '@/utils/revisionSummary'

/** 五类业务对象的表名（与 Dexie 表一一对应） */
export const ENTITY_TABLE_NAMES: Record<RevisionEntityType, string> = {
  section: 'sections',
  ring: 'rings',
  crack: 'cracks',
  survey: 'surveys',
  advice: 'advices'
}

export const ENTITY_TYPES: RevisionEntityType[] = ['section', 'ring', 'crack', 'survey', 'advice']

export interface ChainContext {
  sectionMap: Map<string, Section>
  ringMap: Map<string, Ring>
  crackMap: Map<string, Crack>
}

export function buildChainContext(sections: Section[], rings: Ring[], cracks: Crack[]): ChainContext {
  return {
    sectionMap: new Map(sections.map((row) => [row.id, row])),
    ringMap: new Map(rings.map((row) => [row.id, row])),
    crackMap: new Map(cracks.map((row) => [row.id, row]))
  }
}

/** 关联对象描述：写入时快照父级名称，父级删除后链条仍可读 */
export function relatedLabelFor(
  entityType: RevisionEntityType,
  row: Partial<BusinessRow>,
  ctx: ChainContext
): string {
  if (entityType === 'ring') {
    const r = row as Partial<Ring>
    const section = r.sectionId ? ctx.sectionMap.get(r.sectionId) : undefined
    return section ? section.line : ''
  }
  if (entityType === 'crack') {
    const r = row as Partial<Crack>
    const ring = r.ringId ? ctx.ringMap.get(r.ringId) : undefined
    const section =
      (r.sectionId ? ctx.sectionMap.get(r.sectionId) : undefined) ??
      (ring ? ctx.sectionMap.get(ring.sectionId) : undefined)
    return [section ? section.line : '', ring ? `第${ring.ringNo}环` : ''].filter(Boolean).join(' ')
  }
  if (entityType === 'survey') {
    const r = row as Partial<Survey>
    const crack = r.crackId ? ctx.crackMap.get(r.crackId) : undefined
    return crack ? `${crack.code} 第${r.seq ?? '?'}测次` : ''
  }
  if (entityType === 'advice') {
    const r = row as Partial<Advice>
    const crack = r.crackId ? ctx.crackMap.get(r.crackId) : undefined
    return crack ? crack.code : ''
  }
  return ''
}

export interface InitialRevisionOptions {
  source: string
  operator: string
  /** 链首时间戳：补链时取业务行当时的 createdAt，按「当时内容」落地初始链 */
  createdAt: number
  action?: RevisionAction
}

/** 为单个业务行构造链首修订记录（建档 / 补链） */
export function buildInitialRevision(
  entityType: RevisionEntityType,
  row: BusinessRow,
  ctx: ChainContext,
  options: InitialRevisionOptions
): Revision {
  return {
    id: createId('rev'),
    entityType,
    entityId: row.id,
    seq: 1,
    prevId: null,
    source: options.source,
    action: options.action ?? (options.source === REVISION_SOURCES.seed ? 'init' : 'backfill'),
    prevSummary: null,
    summary: summarizeRow(entityType, row),
    changes: [],
    entityLabel: businessLabel(entityType, row),
    relatedLabel: relatedLabelFor(entityType, row, ctx),
    operator: options.operator,
    tombstone: false,
    createdAt: options.createdAt
  }
}

export interface AllChainRows {
  sections: Section[]
  rings: Ring[]
  cracks: Crack[]
  surveys: Survey[]
  advices: Advice[]
}

/** 为整库每个业务行构造一条初始链（旧数据升级 / 播种 / 导入时使用） */
export function buildInitialChainRows(
  data: AllChainRows,
  options: Omit<InitialRevisionOptions, 'createdAt'> & { createdAt?: number }
): Revision[] {
  const ctx = buildChainContext(data.sections, data.rings, data.cracks)
  const groups: Array<[RevisionEntityType, BusinessRow[]]> = [
    ['section', data.sections],
    ['ring', data.rings],
    ['crack', data.cracks],
    ['survey', data.surveys],
    ['advice', data.advices]
  ]
  const rows: Revision[] = []
  for (const [entityType, list] of groups) {
    list.forEach((row) => {
      rows.push(
        buildInitialRevision(entityType, row, ctx, {
          source: options.source,
          operator: options.operator,
          action: options.action,
          createdAt: options.createdAt ?? ('createdAt' in row ? Number(row.createdAt) : Date.now())
        })
      )
    })
  }
  return rows
}

export interface NextRevisionOptions {
  source: string
  operator?: string
  now?: number
  /** 删除墓碑：当前摘要置为删除说明 */
  tombstone?: boolean
}

/**
 * 在既有链上追加下一条修订记录。
 * @param last 该对象链上最后一条；为 null 时先产出「写入时补建」链首，再追加更正
 * @param before 变更前业务行（无链补建时为 null，diff 从空开始）
 * @param after 变更后业务行（删除时仍传被删除的行用于标识）
 * @returns head 为无链场景需一并写入的补链首记录（已有链时为 null）；revision 为本次更正记录
 */
export function buildNextRevision(
  entityType: RevisionEntityType,
  after: BusinessRow,
  before: Partial<BusinessRow> | null,
  last: Revision | null,
  ctx: ChainContext,
  options: NextRevisionOptions,
  changesOverride?: RevisionFieldChange[]
): { head: Revision | null; revision: Revision } {
  const now = options.now ?? Date.now()
  const isTombstone = options.tombstone === true

  let head: Revision | null = null
  let prev = last
  if (!prev) {
    // 旧记录在写入前没有链：先按当时内容补一条链首（缺失不算篡改）
    head = buildInitialRevision(entityType, (before as BusinessRow) ?? after, ctx, {
      source: REVISION_SOURCES.writeTimeBackfill,
      operator: options.operator ?? DEFAULT_OPERATOR,
      createdAt: (before && 'createdAt' in before ? Number(before.createdAt) : NaN) || now,
      action: 'backfill'
    })
    prev = head
  }

  const changes =
    changesOverride ??
    (isTombstone || before === null ? [] : diffRows(entityType, before, after))
  const revision: Revision = {
    id: createId('rev'),
    entityType,
    entityId: after.id,
    seq: prev.seq + 1,
    prevId: prev.id,
    source: options.source,
    action: 'correct',
    prevSummary: prev.summary,
    summary: isTombstone ? TOMBSTONE_SUMMARY : summarizeRow(entityType, after),
    changes,
    entityLabel: businessLabel(entityType, after),
    relatedLabel: relatedLabelFor(entityType, after, ctx),
    operator: options.operator ?? DEFAULT_OPERATOR,
    tombstone: isTombstone,
    createdAt: now
  }
  return { head, revision }
}

