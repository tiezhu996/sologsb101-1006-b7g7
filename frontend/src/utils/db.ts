/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与 upgrade 迁移逻辑
 * - 表级增删改查、级联删除、整库导入导出
 * - revisions 修订链表：现场台账与修订链物理分离，纠错只追加、不覆盖
 * - 纯前端应用：不依赖任何后端服务或数据库
 */
import Dexie, { type Table, type Transaction } from 'dexie'
import type { Section } from '@/types/section'
import type { Ring } from '@/types/ring'
import type { Crack } from '@/types/crack'
import type { Survey } from '@/types/survey'
import type { Advice } from '@/types/advice'
import type { Revision, RevisionEntityType } from '@/types/revision'
import { REVISION_SOURCES } from '@/types/revision'
import {
  buildChainContext,
  buildInitialChainRows,
  buildNextRevision
} from '@/utils/revisionChain'
import type { BusinessRow } from '@/utils/revisionSummary'

export { createId } from '@/utils/id'

/** IndexedDB 数据库名 */
export const DB_NAME = 'gbtunnelcrack'

/** 当前数据结构版本号：调整表结构必须递增并补 upgrade 迁移 */
export const DB_VERSION = 3

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbtunnelcrack:db-version',
  lastBackupAt: 'gbtunnelcrack:last-backup-at',
  uiPrefs: 'gbtunnelcrack:ui-prefs'
} as const

export interface UiPrefs {
  lastSectionId: string | null
  trendOnlyWarning: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastSectionId: null,
  trendOnlyWarning: false
}

/** 整库备份文件结构 */
export interface BackupPayload {
  app: 'gbtunnelcrack'
  dbVersion: number
  exportedAt: string
  sections: Section[]
  rings: Ring[]
  cracks: Crack[]
  surveys: Survey[]
  advices: Advice[]
  /** 修订链：旧版存档可能没有该字段，导入时按当时内容补初始链 */
  revisions?: Revision[]
}

/** 带行修订号的持久化实体，便于逐行迁移 */
export interface Revisioned {
  /** 数据行结构修订号，便于后续按行迁移 */
  revision?: number
}

export const ROW_REVISION = 3

export type SectionRow = Section & Revisioned
export type RingRow = Ring & Revisioned
export type CrackRow = Crack & Revisioned
export type SurveyRow = Survey & Revisioned
export type AdviceRow = Advice & Revisioned

type BusinessTable =
  | Table<SectionRow, string>
  | Table<RingRow, string>
  | Table<CrackRow, string>
  | Table<SurveyRow, string>
  | Table<AdviceRow, string>

class TunnelCrackDatabase extends Dexie {
  sections!: Table<SectionRow, string>
  rings!: Table<RingRow, string>
  cracks!: Table<CrackRow, string>
  surveys!: Table<SurveyRow, string>
  advices!: Table<AdviceRow, string>
  revisions!: Table<Revision, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构
    this.version(1).stores({
      sections: 'id, line, structureType, startMileage',
      rings: 'id, sectionId, ringNo, mileage',
      cracks: 'id, ringId, code, position, direction, state',
      surveys: 'id, crackId, seq, date',
      advices: 'id, crackId, level, measure, state'
    })

    // v2：裂缝补充 sectionId 冗余列（按区间筛选/统计免联表）；复测补充 surveyor 索引；建议补充 note 字段
    this.version(2).stores({
      sections: 'id, line, structureType, startMileage, updatedAt',
      rings: 'id, sectionId, ringNo, mileage, segmentType, updatedAt',
      cracks: 'id, ringId, sectionId, code, position, direction, state, updatedAt',
      surveys: 'id, crackId, seq, date, surveyor, updatedAt',
      advices: 'id, crackId, level, measure, state, updatedAt'
    }).upgrade(async (tx) => {
      // 迁移 1：为全部业务行补齐 revision
      const tables: Array<Table<Record<string, unknown>, string>> = [
        tx.table('sections'),
        tx.table('rings'),
        tx.table('cracks'),
        tx.table('surveys'),
        tx.table('advices')
      ]
      for (const table of tables) {
        await table.toCollection().modify((row: Record<string, unknown>) => {
          row.revision = ROW_REVISION_V2
        })
      }

      // 迁移 2：历史裂缝缺少 sectionId，用所属环片回填
      const ringRows = (await tx.table('rings').toArray()) as Array<{ id: string; sectionId: string }>
      const sectionOfRing = new Map(ringRows.map((ring) => [ring.id, ring.sectionId]))
      await tx
        .table('cracks')
        .toCollection()
        .modify((crack: Record<string, unknown>) => {
          if (typeof crack.sectionId !== 'string' || crack.sectionId.length === 0) {
            crack.sectionId = sectionOfRing.get(String(crack.ringId)) ?? ''
          }
          if (typeof crack.state !== 'string') crack.state = '观察'
        })

      // 迁移 3：复测缺失变化量时按前一次测次补算（仅补 0，避免误判速率）
      await tx
        .table('surveys')
        .toCollection()
        .modify((survey: Record<string, unknown>) => {
          if (typeof survey.deltaWidthMm !== 'number' || !Number.isFinite(survey.deltaWidthMm)) {
            survey.deltaWidthMm = 0
          }
        })
    })

    // v3：新增 revisions 修订链表（现场台账与修订链分离）
    // 索引：[entityType+entityId] 按对象取链、[entityType+seq] 全库扫描
    this.version(DB_VERSION).stores({
      revisions: 'id, entityType, entityId, createdAt, [entityType+entityId], [entityType+seq]'
    }).upgrade(async (tx) => {
      // 旧数据升级：按当时内容补初始链；字段缺失以「缺失」入摘要，不算篡改。
      // 运行在升级事务内，任何一步失败整个 v2→v3 升级回滚到写入前状态。
      const [sections, rings, cracks, surveys, advices] = await Promise.all([
        tx.table<SectionRow, string>('sections').toArray(),
        tx.table<RingRow, string>('rings').toArray(),
        tx.table<CrackRow, string>('cracks').toArray(),
        tx.table<SurveyRow, string>('surveys').toArray(),
        tx.table<AdviceRow, string>('advices').toArray()
      ])
      const revisions = buildInitialChainRows(
        { sections, rings, cracks, surveys, advices },
        { source: REVISION_SOURCES.backfill, operator: '系统升级' }
      )
      if (revisions.length > 0) await tx.table<Revision, string>('revisions').bulkAdd(revisions)
    })
  }
}

const ROW_REVISION_V2 = 2

export const db = new TunnelCrackDatabase()

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-20T09:00:00+08:00')

function stamp(offsetDays = 0): number {
  return SEED_STAMP + offsetDays * 86400000
}

const SEED_SECTIONS: SectionRow[] = [
  {
    id: 'sec-1',
    line: '1号线',
    startMileage: 12300,
    endMileage: 13150,
    structureType: '盾构',
    ringCount: 42,
    createdAt: stamp(-120),
    updatedAt: stamp(-6),
    revision: ROW_REVISION
  },
  {
    id: 'sec-2',
    line: '2号线',
    startMileage: 5000,
    endMileage: 5720,
    structureType: '明挖',
    ringCount: 36,
    createdAt: stamp(-96),
    updatedAt: stamp(-4),
    revision: ROW_REVISION
  }
]

const SEED_RINGS: RingRow[] = [
  { id: 'ring-1', sectionId: 'sec-1', ringNo: 118, mileage: 12300, segmentType: '钢筋混凝土', installDate: '2016-04-18', createdAt: stamp(-118), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'ring-2', sectionId: 'sec-1', ringNo: 132, mileage: 12468, segmentType: '钢筋混凝土', installDate: '2016-05-02', createdAt: stamp(-117), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'ring-3', sectionId: 'sec-1', ringNo: 145, mileage: 12625, segmentType: '铸铁', installDate: '2016-06-11', createdAt: stamp(-116), updatedAt: stamp(-5), revision: ROW_REVISION },
  { id: 'ring-4', sectionId: 'sec-2', ringNo: 27, mileage: 5080, segmentType: '钢筋混凝土', installDate: '2019-09-23', createdAt: stamp(-95), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'ring-5', sectionId: 'sec-2', ringNo: 41, mileage: 5220, segmentType: '钢管片', installDate: '2019-10-30', createdAt: stamp(-94), updatedAt: stamp(-4), revision: ROW_REVISION }
]

const SEED_CRACKS: CrackRow[] = [
  { id: 'crack-1', ringId: 'ring-1', sectionId: 'sec-1', code: 'SL-118-01', position: '拱顶', direction: '纵向', widthMm: 0.42, lengthMm: 620, state: '待整治', createdAt: stamp(-110), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'crack-2', ringId: 'ring-1', sectionId: 'sec-1', code: 'SL-118-02', position: '侧墙', direction: '环向', widthMm: 0.18, lengthMm: 410, state: '观察', createdAt: stamp(-110), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'crack-3', ringId: 'ring-2', sectionId: 'sec-1', code: 'SL-132-01', position: '道床', direction: '斜向', widthMm: 0.55, lengthMm: 880, state: '待整治', createdAt: stamp(-104), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'crack-4', ringId: 'ring-3', sectionId: 'sec-1', code: 'SL-145-01', position: '拱顶', direction: '环向', widthMm: 0.24, lengthMm: 350, state: '观察', createdAt: stamp(-99), updatedAt: stamp(-9), revision: ROW_REVISION },
  { id: 'crack-5', ringId: 'ring-4', sectionId: 'sec-2', code: 'NL-027-01', position: '侧墙', direction: '纵向', widthMm: 0.38, lengthMm: 540, state: '已整治', createdAt: stamp(-88), updatedAt: stamp(-20), revision: ROW_REVISION },
  { id: 'crack-6', ringId: 'ring-5', sectionId: 'sec-2', code: 'NL-041-01', position: '拱顶', direction: '斜向', widthMm: 0.12, lengthMm: 260, state: '观察', createdAt: stamp(-60), updatedAt: stamp(-6), revision: ROW_REVISION }
]

const SEED_SURVEYS: SurveyRow[] = [
  // crack-1：0.42 → 0.71 → 1.02，末次月均 0.31 mm/月（严重）
  { id: 'sv-1-1', crackId: 'crack-1', seq: 1, date: '2024-04-08', widthMm: 0.42, lengthMm: 620, deltaWidthMm: 0, surveyor: '周维', createdAt: stamp(-73), updatedAt: stamp(-73), revision: ROW_REVISION },
  { id: 'sv-1-2', crackId: 'crack-1', seq: 2, date: '2024-05-08', widthMm: 0.71, lengthMm: 690, deltaWidthMm: 0.29, surveyor: '周维', createdAt: stamp(-43), updatedAt: stamp(-43), revision: ROW_REVISION },
  { id: 'sv-1-3', crackId: 'crack-1', seq: 3, date: '2024-06-07', widthMm: 1.02, lengthMm: 745, deltaWidthMm: 0.31, surveyor: '李文博', createdAt: stamp(-13), updatedAt: stamp(-13), revision: ROW_REVISION },
  // crack-2：0.18 → 0.21 → 0.25，末次月均 0.04 mm/月（一般）
  { id: 'sv-2-1', crackId: 'crack-2', seq: 1, date: '2024-04-10', widthMm: 0.18, lengthMm: 410, deltaWidthMm: 0, surveyor: '李文博', createdAt: stamp(-71), updatedAt: stamp(-71), revision: ROW_REVISION },
  { id: 'sv-2-2', crackId: 'crack-2', seq: 2, date: '2024-05-10', widthMm: 0.21, lengthMm: 430, deltaWidthMm: 0.03, surveyor: '李文博', createdAt: stamp(-41), updatedAt: stamp(-41), revision: ROW_REVISION },
  { id: 'sv-2-3', crackId: 'crack-2', seq: 3, date: '2024-06-09', widthMm: 0.25, lengthMm: 452, deltaWidthMm: 0.04, surveyor: '李文博', createdAt: stamp(-11), updatedAt: stamp(-11), revision: ROW_REVISION },
  // crack-3：0.55 → 0.72 → 0.98，末次月均 0.26 mm/月（较重）
  { id: 'sv-3-1', crackId: 'crack-3', seq: 1, date: '2024-04-12', widthMm: 0.55, lengthMm: 880, deltaWidthMm: 0, surveyor: '陈立', createdAt: stamp(-69), updatedAt: stamp(-69), revision: ROW_REVISION },
  { id: 'sv-3-2', crackId: 'crack-3', seq: 2, date: '2024-05-12', widthMm: 0.72, lengthMm: 905, deltaWidthMm: 0.17, surveyor: '陈立', createdAt: stamp(-39), updatedAt: stamp(-39), revision: ROW_REVISION },
  { id: 'sv-3-3', crackId: 'crack-3', seq: 3, date: '2024-06-11', widthMm: 0.98, lengthMm: 962, deltaWidthMm: 0.26, surveyor: '陈立', createdAt: stamp(-9), updatedAt: stamp(-9), revision: ROW_REVISION },
  // crack-4：0.24 → 0.30，末次月均 0.06 mm/月（一般）
  { id: 'sv-4-1', crackId: 'crack-4', seq: 1, date: '2024-04-15', widthMm: 0.24, lengthMm: 350, deltaWidthMm: 0, surveyor: '周维', createdAt: stamp(-66), updatedAt: stamp(-66), revision: ROW_REVISION },
  { id: 'sv-4-2', crackId: 'crack-4', seq: 2, date: '2024-05-15', widthMm: 0.3, lengthMm: 366, deltaWidthMm: 0.06, surveyor: '周维', createdAt: stamp(-36), updatedAt: stamp(-36), revision: ROW_REVISION },
  // crack-5（已整治）：0.38 → 0.46 后停止复测
  { id: 'sv-5-1', crackId: 'crack-5', seq: 1, date: '2024-02-20', widthMm: 0.38, lengthMm: 540, deltaWidthMm: 0, surveyor: '陈立', createdAt: stamp(-121), updatedAt: stamp(-121), revision: ROW_REVISION },
  { id: 'sv-5-2', crackId: 'crack-5', seq: 2, date: '2024-03-21', widthMm: 0.46, lengthMm: 548, deltaWidthMm: 0.08, surveyor: '陈立', createdAt: stamp(-91), updatedAt: stamp(-91), revision: ROW_REVISION },
  // crack-6：仅初测一次
  { id: 'sv-6-1', crackId: 'crack-6', seq: 1, date: '2024-05-06', widthMm: 0.12, lengthMm: 260, deltaWidthMm: 0, surveyor: '李文博', createdAt: stamp(-45), updatedAt: stamp(-45), revision: ROW_REVISION }
]

const SEED_ADVICES: AdviceRow[] = [
  { id: 'ad-1', crackId: 'crack-1', level: '严重', measure: '钢板带', basis: '月均发展速率 0.310 mm/月，超过严重阈值 0.25 mm/月', state: '已下发', createdAt: stamp(-10), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'ad-2', crackId: 'crack-3', level: '较重', measure: '嵌缝', basis: '月均发展速率 0.260 mm/月，超过预警阈值 0.10 mm/月', state: '待下发', createdAt: stamp(-8), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'ad-3', crackId: 'crack-5', level: '一般', measure: '观测', basis: '月均发展速率 0.080 mm/月，处于观察范围，整治后继续观测', state: '已完成', createdAt: stamp(-85), updatedAt: stamp(-30), revision: ROW_REVISION },
  { id: 'ad-4', crackId: 'crack-2', level: '一般', measure: '注浆', basis: '宽度缓慢增长，侧墙环向裂缝建议预防性注浆封堵', state: '待下发', createdAt: stamp(-7), updatedAt: stamp(-7), revision: ROW_REVISION }
]

/** 幂等播种：仅当主表为空时写入演示数据（业务行 + 同步落地初始修订链） */
export async function seedDatabase(): Promise<void> {
  await db.transaction('rw', [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions], async () => {
    await db.sections.bulkPut(SEED_SECTIONS)
    await db.rings.bulkPut(SEED_RINGS)
    await db.cracks.bulkPut(SEED_CRACKS)
    await db.surveys.bulkPut(SEED_SURVEYS)
    await db.advices.bulkPut(SEED_ADVICES)
    if ((await db.revisions.count()) === 0) {
      const revisions = buildInitialChainRows(
        {
          sections: SEED_SECTIONS,
          rings: SEED_RINGS,
          cracks: SEED_CRACKS,
          surveys: SEED_SURVEYS,
          advices: SEED_ADVICES
        },
        { source: REVISION_SOURCES.seed, operator: '系统演示' }
      )
      await db.revisions.bulkAdd(revisions)
    }
  })
}

/** 应用启动时调用：打开数据库并在首屏为空时播种 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.sections.count()) === 0) {
    await seedDatabase()
  } else if ((await db.revisions.count()) === 0) {
    // 安全网：v3 升级补链若曾中断 / 旧版库手动建过 v3 结构，启动时按当时内容补初始链。
    // 缺失不算篡改；补链内部幂等，重复执行不多记。失败不阻断应用，核对页可再次重试。
    const { backfillMissingChains } = await import('@/utils/revisionService')
    await backfillMissingChains('系统补链').catch(() => undefined)
  }
}

/* ====================== 修订链：删除墓碑（事务内） ====================== */

/** 在当前事务内读取某对象链上最后一条修订记录 */
async function lastRevisionInTx(tx: Transaction, entityType: string, entityId: string): Promise<Revision | undefined> {
  const rows = await tx
    .table<Revision, string>('revisions')
    .where('[entityType+entityId]')
    .equals([entityType, entityId])
    .toArray()
  return rows.sort((a, b) => b.seq - a.seq)[0]
}

async function readContextInTx(tx: Transaction) {
  const [sections, rings, cracks] = await Promise.all([
    tx.table<SectionRow, string>('sections').toArray(),
    tx.table<RingRow, string>('rings').toArray(),
    tx.table<CrackRow, string>('cracks').toArray()
  ])
  return buildChainContext(sections, rings, cracks)
}

/**
 * 删除业务对象时追加删除墓碑（链条保留备查）。
 * 必须在已包含业务表 + revisions 表的读写事务内调用。
 */
async function appendTombstonesInTx(
  tx: Transaction,
  entityType: RevisionEntityType,
  rows: BusinessRow[]
): Promise<void> {
  if (rows.length === 0) return
  const ctx = await readContextInTx(tx)
  const revisionTable = tx.table<Revision, string>('revisions')
  for (const row of rows) {
    const last = await lastRevisionInTx(tx, entityType, row.id)
    const { head, revision } = buildNextRevision(
      entityType,
      row,
      row,
      last ?? null,
      ctx,
      { source: REVISION_SOURCES.delete, operator: '现场班组', tombstone: true }
    )
    if (head) await revisionTable.add(head)
    await revisionTable.add(revision)
  }
}

/** 删除区间：级联删除环片 → 裂缝 → 复测 → 建议；每一级都追加删除墓碑 */
export async function deleteSectionCascade(sectionId: string): Promise<void> {
  await db.transaction('rw', [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions], async (tx) => {
    const rings = await db.rings.where('sectionId').equals(sectionId).toArray()
    const ringIds = rings.map((ring) => ring.id)
    await deleteCracksOfRings(ringIds)
    if (ringIds.length > 0) {
      await appendTombstonesInTx(tx, 'ring', rings)
      await db.rings.bulkDelete(ringIds)
    }
    const section = await db.sections.get(sectionId)
    await db.sections.delete(sectionId)
    if (section) {
      await appendTombstonesInTx(tx, 'section', [section])
    }
  })
}

/** 删除环片：级联删除裂缝及其下游 */
export async function deleteRingCascade(ringId: string): Promise<void> {
  await db.transaction('rw', [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions], async (tx) => {
    await deleteCracksOfRings([ringId])
    const ring = await db.rings.get(ringId)
    await db.rings.delete(ringId)
    if (ring) {
      await appendTombstonesInTx(tx, 'ring', [ring])
    }
  })
}

/** 删除裂缝：级联删除复测与建议 */
export async function deleteCrackCascade(crackId: string): Promise<void> {
  await db.transaction('rw', [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions], async (tx) => {
    const [surveys, advices, crack] = await Promise.all([
      db.surveys.where('crackId').equals(crackId).toArray(),
      db.advices.where('crackId').equals(crackId).toArray(),
      db.cracks.get(crackId)
    ])
    await db.surveys.where('crackId').equals(crackId).delete()
    await db.advices.where('crackId').equals(crackId).delete()
    await db.cracks.delete(crackId)
    await appendTombstonesInTx(tx, 'survey', surveys)
    await appendTombstonesInTx(tx, 'advice', advices)
    if (crack) await appendTombstonesInTx(tx, 'crack', [crack])
  })
}

async function deleteCracksOfRings(ringIds: string[]): Promise<void> {
  if (ringIds.length === 0) return
  const tx = Dexie.currentTransaction
  if (!tx) return
  const cracks = await db.cracks.where('ringId').anyOf(ringIds).toArray()
  const crackIds = cracks.map((crack) => crack.id)
  if (crackIds.length > 0) {
    const [surveys, advices] = await Promise.all([
      db.surveys.where('crackId').anyOf(crackIds).toArray(),
      db.advices.where('crackId').anyOf(crackIds).toArray()
    ])
    await db.surveys.where('crackId').anyOf(crackIds).delete()
    await db.advices.where('crackId').anyOf(crackIds).delete()
    await db.cracks.bulkDelete(crackIds)
    await appendTombstonesInTx(tx, 'survey', surveys)
    await appendTombstonesInTx(tx, 'advice', advices)
    await appendTombstonesInTx(tx, 'crack', cracks)
  }
}

/* ============================ 整库导入导出 ============================ */

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [sections, rings, cracks, surveys, advices, revisions] = await Promise.all([
    db.sections.count(),
    db.rings.count(),
    db.cracks.count(),
    db.surveys.count(),
    db.advices.count(),
    db.revisions.count()
  ])
  return { sections, rings, cracks, surveys, advices, revisions }
}

/** 导出整库快照（业务表剥离内部 revision 字段；修订链完整导出） */
export async function exportSnapshot(): Promise<BackupPayload> {
  const [sections, rings, cracks, surveys, advices, revisions] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray(),
    db.advices.toArray(),
    db.revisions.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbtunnelcrack',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    sections: sections.map(strip),
    rings: rings.map(strip),
    cracks: cracks.map(strip),
    surveys: surveys.map(strip),
    advices: advices.map(strip),
    revisions
  }
}

/** 用快照覆盖整库；快照缺少修订链的对象按当时内容补初始链（缺失不算篡改） */
export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction('rw', [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions], async () => {
    await Promise.all([
      db.sections.clear(),
      db.rings.clear(),
      db.cracks.clear(),
      db.surveys.clear(),
      db.advices.clear(),
      db.revisions.clear()
    ])
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    const sections = (payload.sections ?? []).map(rev)
    const rings = (payload.rings ?? []).map(rev)
    const cracks = (payload.cracks ?? []).map(rev)
    const surveys = (payload.surveys ?? []).map(rev)
    const advices = (payload.advices ?? []).map(rev)
    await db.sections.bulkPut(sections)
    await db.rings.bulkPut(rings)
    await db.cracks.bulkPut(cracks)
    await db.surveys.bulkPut(surveys)
    await db.advices.bulkPut(advices)

    const incoming = payload.revisions ?? []
    await db.revisions.bulkPut(incoming)
    const linkedKeys = new Set(incoming.map((item) => `${item.entityType}|${item.entityId}`))
    const data = { sections, rings, cracks, surveys, advices }
    const backfills = buildInitialChainRows(data, {
      source: REVISION_SOURCES.importBackfill,
      operator: '存档导入'
    }).filter((row) => !linkedKeys.has(`${row.entityType}|${row.entityId}`))
    if (backfills.length > 0) await db.revisions.bulkAdd(backfills)
  })
}

/** 清空全部业务表（修订链一并清空，保证与台账一致） */
export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions], async () => {
    await Promise.all([
      db.sections.clear(),
      db.rings.clear(),
      db.cracks.clear(),
      db.surveys.clear(),
      db.advices.clear(),
      db.revisions.clear()
    ])
  })
}

/** 清空后重新播种（演示数据重置） */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastSectionId: typeof parsed.lastSectionId === 'string' ? parsed.lastSectionId : null,
      trendOnlyWarning: parsed.trendOnlyWarning === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

/** 记录结构版本号，便于备份页比对 */
export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}

/** 供修订服务与核对扫描复用的只读类型 */
export type { BusinessTable }
