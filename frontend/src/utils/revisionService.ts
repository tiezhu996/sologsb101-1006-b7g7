/**
 * 修订链服务：现场台账与修订链分离后的统一写入口。
 * - 每一次写入（建档 / 纠错 / 状态流转 / 删除）都在同一事务内更新业务行并追加修订记录
 * - 修订记录记来源、前一条摘要、当前摘要；纠错只追加，绝不覆盖
 * - 全库核对扫描：指出第一条摘要对不上的记录及关联对象，区分内容缺失 / 链条断开 / 旧记录未建链
 * - 旧数据补链：按当时内容补初始链；先备份写入前状态，失败恢复并重试，重复操作不多记
 */
import { type Table, type Transaction } from 'dexie'
import type { Section } from '@/types/section'
import type { Ring } from '@/types/ring'
import type { Crack } from '@/types/crack'
import type { Survey } from '@/types/survey'
import type { Advice } from '@/types/advice'
import {
  DEFAULT_OPERATOR,
  type IntegrityIssue,
  type IntegrityReport,
  type Revision,
  type RevisionEntityType,
  type RevisionFieldChange
} from '@/types/revision'
import { db } from '@/utils/db'
import {
  buildChainContext,
  buildInitialRevision,
  buildNextRevision,
  ENTITY_TABLE_NAMES,
  ENTITY_TYPES,
  type ChainContext
} from '@/utils/revisionChain'
import { businessLabel, FIELD_LABELS, mismatchedFields, summarizeRow, type BusinessRow } from '@/utils/revisionSummary'

type RowOf<E extends RevisionEntityType> = (E extends 'section'
  ? Section
  : E extends 'ring'
    ? Ring
    : E extends 'crack'
      ? Crack
      : E extends 'survey'
        ? Survey
        : Advice) & { revision?: number }

const TABLE_NAME_OF: Record<RevisionEntityType, string> = {
  section: 'sections',
  ring: 'rings',
  crack: 'cracks',
  survey: 'surveys',
  advice: 'advices'
}

/** 按实体类型取业务表（统一返回宽类型，避免对具体表做联合类型强转） */
function tableOf(entityType: RevisionEntityType): Table<BusinessRow & { revision?: number }, string> {
  return db.table<BusinessRow & { revision?: number }, string>(TABLE_NAME_OF[entityType])
}

async function readContext(): Promise<ChainContext> {
  const [sections, rings, cracks] = await Promise.all([db.sections.toArray(), db.rings.toArray(), db.cracks.toArray()])
  return buildChainContext(sections, rings, cracks)
}

async function chainOf(entityType: RevisionEntityType, entityId: string): Promise<Revision[]> {
  const rows = await db.revisions
    .where('[entityType+entityId]')
    .equals([entityType, entityId])
    .toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

/** 读取某对象的完整修订链（供修订链抽屉 / 核对页使用） */
export async function listRevisions(entityType: RevisionEntityType, entityId: string): Promise<Revision[]> {
  return chainOf(entityType, entityId)
}

/** 每个对象链上最后一条，按对象映射 */
async function latestRevisionMap(): Promise<Map<string, Revision>> {
  const all = await db.revisions.toArray()
  const map = new Map<string, Revision>()
  for (const row of all) {
    const key = `${row.entityType}|${row.entityId}`
    const prev = map.get(key)
    if (!prev || row.seq > prev.seq) map.set(key, row)
  }
  return map
}

export interface WriteOptions {
  source: string
  operator?: string
  now?: number
}

/* ============================ 建档 ============================ */

/**
 * 新建业务对象：写业务行 + 落链首修订记录（同一事务）。
 * @returns 写入的业务行
 */
export async function createEntity<E extends RevisionEntityType>(
  entityType: E,
  row: RowOf<E>,
  options: WriteOptions
): Promise<RowOf<E>> {
  const table = tableOf(entityType)
  return db.transaction('rw', ['sections','rings','cracks','surveys','advices','revisions'], async () => {
    await table.put(row)
    const ctx = await readContext()
    const revision = buildInitialRevision(entityType, row, ctx, {
      source: options.source,
      operator: options.operator ?? DEFAULT_OPERATOR,
      createdAt: options.now ?? ('createdAt' in row ? Number(row.createdAt) : Date.now()),
      action: 'init'
    })
    await db.revisions.add(revision)
    return row
  })
}

/* ============================ 纠错（只追加） ============================ */

export interface CorrectResult {
  changed: boolean
  revision: Revision | null
}

/**
 * 现场纠错：更新业务行并只追加一条更正记录。
 * - 纳入审计的字段没有变化时不追加（重复操作不能多记）
 * - 旧记录恰好没有链时，先按当时内容补建链首再追加更正
 */
export async function correctEntity(
  entityType: RevisionEntityType,
  entityId: string,
  patch: Partial<BusinessRow>,
  options: WriteOptions
): Promise<CorrectResult> {
  const table = tableOf(entityType)
  return db.transaction('rw', ['sections','rings','cracks','surveys','advices','revisions'], async () => {
    const before = (await table.get(entityId)) as BusinessRow | undefined
    if (!before) return { changed: false, revision: null }
    const after: BusinessRow = { ...before, ...patch, id: entityId } as BusinessRow
    const chain = await chainOf(entityType, entityId)
    const last = chain[chain.length - 1] ?? null
    const ctx = await readContext()
    const { head, revision } = buildNextRevision(entityType, after, before, last, ctx, {
      source: options.source,
      operator: options.operator,
      now: options.now
    })
    if (revision.changes.length === 0 && !head) {
      return { changed: false, revision: null }
    }
    await table.put(after)
    if (head) await db.revisions.add(head)
    await db.revisions.add(revision)
    return { changed: true, revision }
  })
}

/**
 * 批量现场纠错（如批量改裂缝状态）：仅对确有变化的对象追加更正，同一事务提交。
 */
export async function bulkCorrectEntities(
  entityType: RevisionEntityType,
  rows: BusinessRow[],
  patch: Partial<BusinessRow>,
  options: WriteOptions
): Promise<number> {
  if (rows.length === 0) return 0
  const table = tableOf(entityType)
  let appended = 0
  await db.transaction('rw', ['sections','rings','cracks','surveys','advices','revisions'], async () => {
    const ctx = await readContext()
    for (const before of rows) {
      const after = { ...before, ...patch, id: before.id } as BusinessRow
      const chain = await chainOf(entityType, before.id)
      const last = chain[chain.length - 1] ?? null
      const { head, revision } = buildNextRevision(entityType, after, before, last, ctx, options)
      if (revision.changes.length === 0 && !head) continue
      await table.put(after)
      if (head) await db.revisions.add(head)
      await db.revisions.add(revision)
      appended += 1
    }
  })
  return appended
}

/** 删除单个业务对象：追加删除墓碑后删除业务行（链条保留备查） */
export async function deleteEntityWithTombstone(
  entityType: RevisionEntityType,
  entityId: string,
  options: WriteOptions
): Promise<boolean> {
  const table = tableOf(entityType)
  return db.transaction('rw', ['sections','rings','cracks','surveys','advices','revisions'], async () => {
    const before = (await table.get(entityId)) as BusinessRow | undefined
    if (!before) return false
    const chain = await chainOf(entityType, entityId)
    const last = chain[chain.length - 1] ?? null
    const ctx = await readContext()
    const { head, revision } = buildNextRevision(entityType, before, before, last, ctx, {
      source: options.source,
      operator: options.operator,
      now: options.now,
      tombstone: true
    })
    if (head) await db.revisions.add(head)
    await db.revisions.add(revision)
    await table.delete(entityId)
    return true
  })
}

/**
 * 事务内批量给同一对象追加多条更正（复测重排 / 读数同步用）。
 * 必须在调用方已打开的、包含 revisions 与对应业务表的事务内执行。
 */
export async function appendRevisionsInTx(
  tx: Transaction,
  entityType: RevisionEntityType,
  items: Array<{
    before: Partial<BusinessRow> | null
    after: BusinessRow
    source: string
    operator?: string
    changesOverride?: RevisionFieldChange[]
    /** 新建建档：落 init 链首（before 传 null 时必须置 true，避免误判为无链旧数据） */
    initial?: boolean
  }>
): Promise<void> {
  if (items.length === 0) return
  const revisionTable = tx.table<Revision, string>('revisions')
  const ctx = await (async () => {
    const [sections, rings, cracks] = await Promise.all([
      tx.table<Section & { revision?: number }, string>('sections').toArray(),
      tx.table<Ring & { revision?: number }, string>('rings').toArray(),
      tx.table<Crack & { revision?: number }, string>('cracks').toArray()
    ])
    return buildChainContext(sections, rings, cracks)
  })()
  for (const item of items) {
    if (item.initial) {
      const revision = buildInitialRevision(entityType, item.after, ctx, {
        source: item.source,
        operator: item.operator ?? DEFAULT_OPERATOR,
        createdAt: Number((item.after as { createdAt?: number }).createdAt) || Date.now(),
        action: 'init'
      })
      await revisionTable.add(revision)
      continue
    }
    const chain = await revisionTable
      .where('[entityType+entityId]')
      .equals([entityType, item.after.id])
      .toArray()
    const last = chain.sort((a, b) => b.seq - a.seq)[0] ?? null
    const { head, revision } = buildNextRevision(
      entityType,
      item.after,
      (item.before as Partial<BusinessRow> | null) ?? null,
      last,
      ctx,
      { source: item.source, operator: item.operator },
      item.changesOverride
    )
    // 与纠错写入口径一致：没有字段变化且不需要补链首时，不多记
    if (!head && revision.changes.length === 0) continue
    if (head) await revisionTable.add(head)
    await revisionTable.add(revision)
  }
}

/**
 * 事务内追加删除墓碑（复测重排删除等场景复用）。
 * 必须在调用方已打开的、包含 revisions 表的事务内执行。
 */
export async function appendTombstoneInTx(
  tx: Transaction,
  entityType: RevisionEntityType,
  before: BusinessRow,
  options: { source: string; operator?: string }
): Promise<void> {
  const revisionTable = tx.table<Revision, string>('revisions')
  const ctx = await (async () => {
    const [sections, rings, cracks] = await Promise.all([
      tx.table<Section & { revision?: number }, string>('sections').toArray(),
      tx.table<Ring & { revision?: number }, string>('rings').toArray(),
      tx.table<Crack & { revision?: number }, string>('cracks').toArray()
    ])
    return buildChainContext(sections, rings, cracks)
  })()
  const chain = await revisionTable
    .where('[entityType+entityId]')
    .equals([entityType, before.id])
    .toArray()
  const last = chain.sort((a, b) => b.seq - a.seq)[0] ?? null
  const { head, revision } = buildNextRevision(entityType, before, before, last, ctx, {
    source: options.source,
    operator: options.operator,
    tombstone: true
  })
  if (head) await revisionTable.add(head)
  await revisionTable.add(revision)
}

/* ====================== 全库核对扫描（审计抽查） ====================== */

function relatedLabelOf(entityType: RevisionEntityType, entityId: string, ctx: ChainContext): string {
  if (entityType === 'section') {
    return ctx.sectionMap.get(entityId)?.line ?? ''
  }
  if (entityType === 'ring') {
    const ring = ctx.ringMap.get(entityId)
    return ring ? ctx.sectionMap.get(ring.sectionId)?.line ?? '' : ''
  }
  if (entityType === 'crack') {
    const crack = ctx.crackMap.get(entityId)
    const ring = crack ? ctx.ringMap.get(crack.ringId) : undefined
    return [ring ? ctx.sectionMap.get(ring.sectionId)?.line ?? '' : '', ring ? `第${ring.ringNo}环` : '']
      .filter(Boolean)
      .join(' ')
  }
  // 复测 / 建议的关联裂缝需要 surveys→crack 之外的信息，兜底用链记录自带的 relatedLabel
  return ''
}

/**
 * 扫描全库修订链，逐对象核对。
 * 返回第一条摘要对不上的记录及关联对象，并标注问题性质：
 * - unlinked-legacy 旧记录未建链：业务行存在但一条修订记录都没有
 * - broken-chain 链条断开：序号断裂、prevId 指错、前一条摘要与上一条当前摘要不符
 * - missing-content 内容缺失：链首摘要为空 / 链末摘要与台账当前内容对不上 / 业务行已缺失
 */
export async function scanRevisionIntegrity(): Promise<IntegrityReport> {
  const [sections, rings, cracks, surveys, advices, revisions] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray(),
    db.advices.toArray(),
    db.revisions.toArray()
  ])
  const ctx = buildChainContext(sections, rings, cracks)
  const data: Record<RevisionEntityType, BusinessRow[]> = {
    section: sections,
    ring: rings,
    crack: cracks,
    survey: surveys,
    advice: advices
  }
  const rowMap = new Map<string, BusinessRow>()
  let entityTotal = 0
  ENTITY_TYPES.forEach((entityType) => {
    data[entityType].forEach((row) => rowMap.set(`${entityType}|${row.id}`, row))
    entityTotal += data[entityType].length
  })

  const chains = new Map<string, Revision[]>()
  revisions.forEach((revision) => {
    const key = `${revision.entityType}|${revision.entityId}`
    const list = chains.get(key)
    if (list) list.push(revision)
    else chains.set(key, [revision])
  })

  const issues: IntegrityIssue[] = []
  let linkedCount = 0

  const reportIssue = (
    entityType: RevisionEntityType,
    entityId: string,
    chain: Revision[],
    kind: IntegrityIssue['kind'],
    revisionId: string | null,
    detail: string
  ): void => {
    const ordered = [...chain].sort((a, b) => a.seq - b.seq)
    const row = rowMap.get(`${entityType}|${entityId}`)
    const fallbackLabel = row ? businessLabel(entityType, row) : ordered[ordered.length - 1]?.entityLabel ?? entityId
    const related =
      ordered[ordered.length - 1]?.relatedLabel ||
      (row ? relatedLabelOf(entityType, entityId, ctx) : '')
    issues.push({
      entityType,
      entityId,
      entityLabel: ordered[0]?.entityLabel || fallbackLabel,
      relatedLabel: related,
      kind,
      revisionId,
      firstSummary: ordered[0]?.summary ?? '',
      lastSummary: ordered[ordered.length - 1]?.summary ?? '',
      detail
    })
  }

  // 1) 业务行存在但没有任何修订记录 → 旧记录未建链
  for (const entityType of ENTITY_TYPES) {
    for (const row of data[entityType]) {
      const key = `${entityType}|${row.id}`
      if (!chains.has(key)) {
        reportIssue(
          entityType,
          row.id,
          [],
          'unlinked-legacy',
          null,
          '台账中存在该记录，但修订链一条记录都没有，属于旧记录未建链，可按当时内容补初始链。'
        )
      }
    }
  }

  // 2) 逐链核对连续性与首条摘要
  for (const [key, rawChain] of chains) {
    const [entityType, entityId] = key.split('|') as [RevisionEntityType, string]
    const chain = rawChain.sort((a, b) => a.seq - b.seq)
    linkedCount += 1
    const row = rowMap.get(key)
    const first = chain[0]

    let broke: { revisionId: string; detail: string } | null = null
    for (let index = 0; index < chain.length && !broke; index += 1) {
      const revision = chain[index]
      if (revision.seq !== index + 1) {
        broke = { revisionId: revision.id, detail: `第 ${index + 1} 条链记录序号应为 ${index + 1}，实际为 ${revision.seq}，链条断开。` }
        break
      }
      if (index === 0) {
        if (revision.prevId !== null) {
          broke = { revisionId: revision.id, detail: '链首记录的前一条指向不为空，链条断开。' }
          break
        }
        if (!revision.summary) {
          reportIssue(entityType, entityId, chain, 'missing-content', revision.id, '第一条修订记录的摘要为空，无法对账（内容缺失）。')
        }
        continue
      }
      const prev = chain[index - 1]
      if (revision.prevId !== prev.id) {
        broke = {
          revisionId: revision.id,
          detail: `第 ${revision.seq} 条记录的前一条指向与第 ${prev.seq} 条不一致，链条断开。`
        }
        break
      }
      if (revision.prevSummary !== prev.summary) {
        broke = {
          revisionId: revision.id,
          detail: `第 ${revision.seq} 条记录登记的前一条摘要，与第 ${prev.seq} 条的当前摘要对不上，链条断开。`
        }
      }
    }
    if (broke) {
      reportIssue(entityType, entityId, chain, 'broken-chain', broke.revisionId, broke.detail)
      continue
    }

    // 3) 链完整时核对链末摘要与台账当前内容
    const last = chain[chain.length - 1]
    if (last.tombstone) {
      // 删除墓碑：业务行理应已不存在
      if (row) {
        reportIssue(
          entityType,
          entityId,
          chain,
          'missing-content',
          last.id,
          '修订链已记录删除，但台账中仍存在该业务行（删除未落表或记录被恢复），内容对不上。'
        )
      }
      continue
    }
    if (!row) {
      reportIssue(
        entityType,
        entityId,
        chain,
        'missing-content',
        last.id,
        '修订链存在但台账业务行已缺失（可能被直接物理删除而未留墓碑），内容缺失。'
      )
      continue
    }
    const mismatched = mismatchedFields(entityType, last.summary, row)
    if (mismatched.length > 0) {
      const mismatchLabels = mismatched.map((field) => FIELD_LABELS[entityType][field] ?? field)
      reportIssue(
        entityType,
        entityId,
        chain,
        'missing-content',
        first.id,
        `第一条摘要锚定的内容口径与台账当前值在「${mismatchLabels.join('、')}」上对不上，疑似旧值被直接覆盖，缺少更正记录。`
      )
    }
  }

  return {
    issues: issues.sort((a, b) => {
      const weight = { 'unlinked-legacy': 0, 'broken-chain': 1, 'missing-content': 2 }
      const diff = weight[a.kind] - weight[b.kind]
      if (diff !== 0) return diff
      return `${a.entityType}|${a.entityId}`.localeCompare(`${b.entityType}|${b.entityId}`)
    }),
    entityTotal,
    linkedCount,
    revisionCount: revisions.length,
    scannedAt: Date.now()
  }
}

/* ==================== 旧数据补链（可回滚、可重试、幂等） ==================== */

/** 测试专用：在补链写入前注入失败，验证写入前状态恢复 */
let failureHook: ((phase: string) => void) | null = null
export function __setRevisionFailureHookForTest(hook: ((phase: string) => void) | null): void {
  failureHook = hook
}

export interface BackfillResult {
  /** 本次实际补建的对象数；重复执行且没有新无链对象时为 0 */
  backfilled: number
  /** 是否发生过失败后恢复并重试成功 */
  recovered: boolean
}

/**
 * 为所有「旧记录未建链」的对象按当时内容补初始链。
 * - 先快照写入前 revisions 全量；失败时恢复到写入前状态后重试一次
 * - 已有链的对象一律跳过：重复操作不多记
 * - 字段缺失按「缺失」入摘要，不算篡改
 */
export async function backfillMissingChains(operator = '系统补链'): Promise<BackfillResult> {
  const targets = await findBackfillTargets()
  if (targets.length === 0) return { backfilled: 0, recovered: false }

  // 写入前状态快照（用于失败后恢复）
  const snapshot = await db.revisions.toArray()

  let recovered = false
  try {
    await runBackfillOnce(targets, operator, false)
  } catch (firstError) {
    // 恢复到写入前状态：清空被污染的修订表并整体还原
    await db.transaction('rw', db.revisions, async () => {
      await db.revisions.clear()
      await db.revisions.bulkAdd(snapshot)
    })
    recovered = true
    // 恢复完成后重试（重试幂等：仍按当前库内链状态挑选无链对象）
    const retryTargets = await findBackfillTargets()
    await runBackfillOnce(retryTargets, operator, true)
    return { backfilled: retryTargets.length, recovered }
  }
  return { backfilled: targets.length, recovered }
}

interface BackfillTarget {
  entityType: RevisionEntityType
  row: BusinessRow
}

async function findBackfillTargets(): Promise<BackfillTarget[]> {
  const latestMap = await latestRevisionMap()
  const targets: BackfillTarget[] = []
  for (const entityType of ENTITY_TYPES) {
    const rows = await tableOf(entityType).toArray()
    for (const row of rows) {
      if (!latestMap.has(`${entityType}|${row.id}`)) {
        targets.push({ entityType, row })
      }
    }
  }
  return targets
}

async function runBackfillOnce(targets: BackfillTarget[], operator: string, isRetry: boolean): Promise<void> {
  await db.transaction('rw', [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions], async () => {
    const [sections, rings, cracks] = await Promise.all([db.sections.toArray(), db.rings.toArray(), db.cracks.toArray()])
    const ctx = buildChainContext(sections, rings, cracks)
    const phase = isRetry ? 'retry' : 'first'
    for (const { entityType, row } of targets) {
      const existing = await db.revisions
        .where('[entityType+entityId]')
        .equals([entityType, row.id])
        .count()
      // 事务内再查一次：已建链则跳过，保证重复操作不多记
      if (existing > 0) continue
      failureHook?.(`${phase}:${entityType}:${row.id}`)
      const revision = buildInitialRevision(entityType, row, ctx, {
        source: '旧数据升级补链',
        operator,
        createdAt: Number(row.createdAt) || Date.now(),
        action: 'backfill'
      })
      await db.revisions.add(revision)
    }
  })
}

export { ENTITY_TABLE_NAMES, summarizeRow }
