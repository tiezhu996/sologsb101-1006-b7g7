/**
 * 台账写入网关：现场台账与修订链分离
 *
 * 五类业务对象（区间/环片/裂缝/复测测次/整治建议）的每次写入都经此模块：
 *  - 新增：写台账当前值 + 追加一条 initial 修订（来源、当前摘要）
 *  - 纠错：不就地覆盖历史，只在链尾追加一条 correction 修订
 *         （来源、前一条摘要、当前摘要、字段变化），台账更新为最新值
 *  - 未建链旧行被直接写入时：先按写入前内容补初始链，再追加更正记录
 *  - 补链：按当时内容生成初始记录；事务失败整体回滚到写入前状态，可幂等重试
 */
import { db, createId } from '@/utils/db'
import {
  ENTITY_TABLE_NAME,
  REVISION_ENTITY_TYPES,
  REVISION_SOURCE,
  type RevisionEntityType,
  type RevisionRecord,
  type WriteContext
} from '@/types/revision'
import { changedKeys, describeChanges, summaryOf, trackedSnapshot } from '@/utils/ledgerSummary'

export interface LedgerRow {
  id: string
  createdAt?: number
  updatedAt?: number
}

/* ------------------------- 升级/种子/导入共用：补链核心 ------------------------- */

export interface BackfillOptions {
  source: string
  action?: string
  at?: number
}

export interface BackfillResult {
  /** 新建初始链条数 */
  created: number
  /** 已有链而跳过的对象数（重复操作不多记） */
  skipped: number
  /** 失败定位：entityType|entityId */
  failed: string[]
  /** 新建链的定位清单 */
  ids: string[]
}

/** Dexie 实例与升级/业务事务都具备 table()，结构兼容 */
interface LedgerDbLike {
  table(name: string): {
    toArray(): Promise<Array<Record<string, unknown>>>
    bulkAdd(rows: RevisionRecord[]): Promise<unknown>
    add(row: RevisionRecord): Promise<unknown>
  }
}

/**
 * 为所有缺链对象按当时内容补初始链。
 * 纯补链步骤，不自行开启事务——由调用方保证事务边界（升级回调/种子事务/运行时事务）。
 * 幂等：已有链的对象一律跳过，重复调用不会多记。
 */
export async function backfillMissingChainsIn(dbx: LedgerDbLike, options: BackfillOptions): Promise<BackfillResult> {
  const at = options.at ?? Date.now()
  const result: BackfillResult = { created: 0, skipped: 0, failed: [], ids: [] }

  const revisionTable = dbx.table('revisions')
  const existing = (await revisionTable.toArray()) as Array<{ entityType: string; entityId: string }>
  const chained = new Set(existing.map((item) => `${item.entityType}|${item.entityId}`))

  for (const entityType of REVISION_ENTITY_TYPES) {
    const rows = await dbx.table(ENTITY_TABLE_NAME[entityType]).toArray()
    const additions: RevisionRecord[] = []
    for (const row of rows) {
      const key = `${entityType}|${String(row.id)}`
      if (chained.has(key)) {
        result.skipped += 1
        continue
      }
      try {
        additions.push(buildInitialRevision(entityType, row, options.source, options.action ?? '按当时内容补初始链', at))
        chained.add(key)
      } catch {
        result.failed.push(key)
      }
    }
    if (additions.length > 0) {
      await revisionTable.bulkAdd(additions)
      additions.forEach((revision) => {
        result.created += 1
        result.ids.push(`${revision.entityType}|${revision.entityId}`)
      })
    }
  }
  return result
}

/* ------------------------------ 修订记录构造 ------------------------------ */

function nextRevisionId(): string {
  return createId('rev')
}

/** 由对象当时内容构造初始修订（缺失字段照实进快照，审计判内容缺失而非篡改） */
export function buildInitialRevision(
  entityType: RevisionEntityType,
  row: Record<string, unknown>,
  source: string,
  action: string,
  at: number
): RevisionRecord {
  const snapshot = trackedSnapshot(entityType, row)
  return {
    id: nextRevisionId(),
    entityType,
    entityId: String(row.id),
    seq: 1,
    kind: 'initial',
    source,
    action,
    prevId: null,
    prevSummary: null,
    summary: summaryOf(entityType, snapshot),
    snapshot,
    fields: Object.keys(snapshot),
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : at,
    recordedAt: at
  }
}

function buildCorrectionRevision(
  entityType: RevisionEntityType,
  entityId: string,
  seq: number,
  previous: RevisionRecord,
  afterRow: Record<string, unknown>,
  keys: string[],
  context: WriteContext,
  at: number
): RevisionRecord {
  const snapshot = trackedSnapshot(entityType, afterRow)
  return {
    id: nextRevisionId(),
    entityType,
    entityId,
    seq,
    kind: 'correction',
    source: context.source,
    action: context.action ?? '现场纠错',
    prevId: previous.id,
    prevSummary: previous.summary,
    summary: summaryOf(entityType, snapshot),
    snapshot,
    fields: keys,
    changedSummary: describeChanges(entityType, previous.snapshot, snapshot, keys),
    createdAt: typeof afterRow.createdAt === 'number' ? afterRow.createdAt : at,
    recordedAt: at
  }
}

/* ------------------------------ 运行时补链 ------------------------------ */

/** 补链串行锁：并发调用合并为同一次，杜绝重复建链 */
let backfillInFlight: Promise<BackfillResult> | null = null

/**
 * 全库补初始链（核对页「一键补链」/ 启动兜底使用）。
 * 单事务提交，失败即回滚到写入前状态；回滚后自动重试一次；全程幂等。
 */
export async function backfillMissingChains(options?: Partial<BackfillOptions>): Promise<BackfillResult> {
  if (backfillInFlight) return backfillInFlight
  const merged: BackfillOptions = {
    source: REVISION_SOURCE.auditBackfill,
    action: '审计核对补链',
    ...options
  }
  const run = async (): Promise<BackfillResult> => {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result: BackfillResult = await db.transaction(
          'rw',
          [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions],
          (tx) => backfillMissingChainsIn(tx, { ...merged, at: merged.at ?? Date.now() })
        )
        if (result.failed.length > 0) throw new Error(`补链失败：${result.failed.join('、')}`)
        return result
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('修订链补链失败，已回滚')
  }
  const promise = run().finally(() => {
    if (backfillInFlight === promise) backfillInFlight = null
  })
  backfillInFlight = promise
  return promise
}

/** 核对页对单条「未建链」问题补初始链；已有链时幂等跳过 */
export async function repairEntityChain(
  entityType: RevisionEntityType,
  entityId: string,
  options?: Partial<BackfillOptions>
): Promise<BackfillResult> {
  const at = options?.at ?? Date.now()
  return db.transaction('rw', db.table(ENTITY_TABLE_NAME[entityType]), db.revisions, async (tx) => {
    const key = `${entityType}|${entityId}`
    const count = await tx
      .table('revisions')
      .where('[entityType+entityId]')
      .equals([entityType, entityId])
      .count()
    if (count > 0) return { created: 0, skipped: 1, failed: [], ids: [] }
    const row = (await tx.table(ENTITY_TABLE_NAME[entityType]).get(entityId)) as Record<string, unknown> | undefined
    if (!row) return { created: 0, skipped: 0, failed: [key], ids: [] }
    await tx
      .table('revisions')
      .add(
        buildInitialRevision(
          entityType,
          row,
          options?.source ?? REVISION_SOURCE.auditBackfill,
          options?.action ?? '审计核对补链',
          at
        )
      )
    return { created: 1, skipped: 0, failed: [], ids: [key] }
  })
}

/* ------------------------------ 台账写入网关 ------------------------------ */

export interface InsertOptions extends WriteContext {
  idPrefix: string
  at?: number
  id?: string
  createdAt?: number
}

/** 新增业务对象：台账当前值 + initial 修订，同一事务提交 */
export async function insertEntity<T extends LedgerRow>(
  entityType: RevisionEntityType,
  payload: Record<string, unknown>,
  options: InsertOptions
): Promise<T> {
  const at = options.at ?? Date.now()
  return db.transaction('rw', db.table(ENTITY_TABLE_NAME[entityType]), db.revisions, async (tx) => {
    const record = {
      ...payload,
      id: options.id ?? (payload.id as string | undefined) ?? createId(options.idPrefix),
      createdAt: options.createdAt ?? (payload.createdAt as number | undefined) ?? at,
      updatedAt: at
    }
    await tx.table(ENTITY_TABLE_NAME[entityType]).add(record)
    await tx
      .table('revisions')
      .add(
        buildInitialRevision(
          entityType,
          record as Record<string, unknown>,
          options.source,
          options.action ?? '初始建账',
          at
        )
      )
    return record as unknown as T
  })
}

export interface UpdateEntityResult<T> {
  /** 是否有跟踪字段实际变化（无变化不追加修订，重复操作不多记） */
  changed: boolean
  keys: string[]
  row: T
  /** 本次写入前为未建链旧行，已先补初始链 */
  backfilled: boolean
}

/**
 * 纠错写入：台账更新为最新值，链尾只追加 correction 修订；
 * 跟踪字段无变化时不追加修订（仅刷新 updatedAt）。
 */
export async function updateEntity<T extends LedgerRow>(
  entityType: RevisionEntityType,
  entityId: string,
  patch: Record<string, unknown>,
  context: WriteContext,
  atInput?: number
): Promise<UpdateEntityResult<T>> {
  const at = atInput ?? Date.now()
  return db.transaction('rw', db.table(ENTITY_TABLE_NAME[entityType]), db.revisions, async (tx) => {
    const entityTable = tx.table(ENTITY_TABLE_NAME[entityType])
    const revisionTable = tx.table('revisions')
    const existing = (await entityTable.get(entityId)) as Record<string, unknown> | undefined
    if (!existing) throw new Error('台账记录不存在，无法写入修订链')

    const next = { ...existing, ...patch }
    const beforeSnapshot = trackedSnapshot(entityType, existing)
    const afterSnapshot = trackedSnapshot(entityType, next)
    const keys = changedKeys(entityType, beforeSnapshot, afterSnapshot)

    if (keys.length === 0) {
      await entityTable.update(entityId, { updatedAt: at })
      return { changed: false, keys, row: next as unknown as T, backfilled: false }
    }

    next.updatedAt = at
    await entityTable.put(next)

    const chain = (await revisionTable
      .where('[entityType+entityId]')
      .equals([entityType, entityId])
      .toArray()) as RevisionRecord[]
    chain.sort((a, b) => a.seq - b.seq || a.recordedAt - b.recordedAt)

    if (chain.length === 0) {
      // 旧行未建链：按写入前内容补初始链，再追加本次更正（缺失不算篡改，纠错仍留痕）
      const initial = buildInitialRevision(
        entityType,
        existing,
        REVISION_SOURCE.auditBackfill,
        '写入时发现旧记录未建链，按写入前内容补初始链',
        at
      )
      await revisionTable.add(initial)
      await revisionTable.add(
        buildCorrectionRevision(entityType, entityId, 2, initial, next, keys, context, at)
      )
      return { changed: true, keys, row: next as unknown as T, backfilled: true }
    }

    const last = chain[chain.length - 1]
    await revisionTable.add(
      buildCorrectionRevision(entityType, entityId, last.seq + 1, last, next, keys, context, at)
    )
    return { changed: true, keys, row: next as unknown as T, backfilled: false }
  })
}

export interface CommitResult {
  updated: number
  unchanged: number
  appended: number
  backfilled: number
  failed: string[]
}

/**
 * 批量纠错（如批量改状态、系统重算变化量）：
 * 单事务内逐条比对，仅对实际变化追加更正记录，天然幂等。
 */
export async function commitEntities(
  entityType: RevisionEntityType,
  items: Array<{ id: string; patch: Record<string, unknown> }>,
  context: WriteContext,
  atInput?: number
): Promise<CommitResult> {
  const at = atInput ?? Date.now()
  return db.transaction('rw', db.table(ENTITY_TABLE_NAME[entityType]), db.revisions, async (tx) => {
    const entityTable = tx.table(ENTITY_TABLE_NAME[entityType])
    const revisionTable = tx.table('revisions')
    const result: CommitResult = { updated: 0, unchanged: 0, appended: 0, backfilled: 0, failed: [] }

    for (const item of items) {
      try {
        const existing = (await entityTable.get(item.id)) as Record<string, unknown> | undefined
        if (!existing) {
          result.failed.push(`${entityType}|${item.id}`)
          continue
        }
        const next = { ...existing, ...item.patch }
        const keys = changedKeys(
          entityType,
          trackedSnapshot(entityType, existing),
          trackedSnapshot(entityType, next)
        )
        if (keys.length === 0) {
          result.unchanged += 1
          continue
        }
        next.updatedAt = at
        await entityTable.put(next)

        const chain = (await revisionTable
          .where('[entityType+entityId]')
          .equals([entityType, item.id])
          .toArray()) as RevisionRecord[]
        chain.sort((a, b) => a.seq - b.seq || a.recordedAt - b.recordedAt)
        if (chain.length === 0) {
          const initial = buildInitialRevision(
            entityType,
            existing,
            REVISION_SOURCE.auditBackfill,
            '写入时发现旧记录未建链，按写入前内容补初始链',
            at
          )
          await revisionTable.add(initial)
          await revisionTable.add(
            buildCorrectionRevision(entityType, item.id, 2, initial, next, keys, context, at)
          )
          result.backfilled += 1
        } else {
          const last = chain[chain.length - 1]
          await revisionTable.add(
            buildCorrectionRevision(entityType, item.id, last.seq + 1, last, next, keys, context, at)
          )
        }
        result.updated += 1
        result.appended += 1
      } catch {
        result.failed.push(`${entityType}|${item.id}`)
      }
    }
    return result
  })
}

/* ------------------------------ 删除（链随台账清除） ------------------------------ */

/** 删除业务对象并清掉其修订链，避免留下孤立修订 */
export async function deleteEntitiesWithChain(entityType: RevisionEntityType, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db.transaction('rw', db.table(ENTITY_TABLE_NAME[entityType]), db.revisions, async (tx) => {
    await tx.table(ENTITY_TABLE_NAME[entityType]).bulkDelete(ids)
    for (const id of ids) {
      await tx
        .table('revisions')
        .where('[entityType+entityId]')
        .equals([entityType, id])
        .delete()
    }
  })
}

/* ------------------------------ 修订链读取 ------------------------------ */

export async function revisionsOf(entityType: RevisionEntityType, entityId: string): Promise<RevisionRecord[]> {
  const list = await db.revisions
    .where('[entityType+entityId]')
    .equals([entityType, entityId])
    .toArray()
  return list.sort((a, b) => a.seq - b.seq || a.recordedAt - b.recordedAt)
}
