/**
 * 复测测次状态（Pinia）
 * 维护测次顺序、变化量缓存与按裂缝汇总的发展速率。
 *
 * 写入约定（修订链分离）：
 * - 追加测次：建档链首
 * - 编辑测次：现场纠错（只追加更正记录），随后同事务重排序号 / 变化量，受影响测次逐条留链
 * - 删除测次：追加删除墓碑（链条保留），后续测次前移并重算留链
 * - 裂缝宽长同步为最新读数：以「复测最新读数同步」来源在裂缝链上追加更正
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { Transaction } from 'dexie'
import { db, createId, ROW_REVISION, type SurveyRow } from '@/utils/db'
import { appendRevisionsInTx, appendTombstoneInTx } from '@/utils/revisionService'
import { REVISION_SOURCES } from '@/types/revision'
import type { Survey, SurveyDraft } from '@/types/survey'
import type { AdviceLevel } from '@/types/advice'
import { buildSurveyPoints, levelFromRate, round } from '@/utils/rate'

export interface CrackRateSummary {
  crackId: string
  /** 测次数量 */
  count: number
  /** 首测宽度（mm） */
  firstWidth: number
  /** 最新宽度（mm） */
  latestWidth: number
  /** 累计变化量（mm） */
  totalDelta: number
  /** 最新测次月均速率（mm/月） */
  rate: number
  level: AdviceLevel
  lastDate: string
}

export const useSurveyStore = defineStore('survey', () => {
  const surveyTable = useIdbTable<SurveyRow>((database) => database.surveys, { sortByUpdatedAt: false })

  /** 正在查看的裂缝 id（复测对比页与速率分级页共用） */
  const activeCrackId = ref<string | null>(null)

  const surveys = computed<SurveyRow[]>(() =>
    [...surveyTable.rows.value].sort((a, b) => {
      const crackDiff = a.crackId.localeCompare(b.crackId)
      if (crackDiff !== 0) return crackDiff
      return a.seq - b.seq
    })
  )

  function surveysOf(crackId: string): Survey[] {
    return surveys.value.filter((survey) => survey.crackId === crackId)
  }

  /** 按裂缝汇总的速率缓存 */
  const rates = computed<CrackRateSummary[]>(() => {
    const grouped = new Map<string, SurveyRow[]>()
    surveys.value.forEach((survey) => {
      const list = grouped.get(survey.crackId)
      if (list) list.push(survey)
      else grouped.set(survey.crackId, [survey])
    })
    const list: CrackRateSummary[] = []
    grouped.forEach((rows, crackId) => {
      const points = buildSurveyPoints(rows)
      const latest = points[points.length - 1]
      const first = points[0]
      const rate = latest ? latest.rate : 0
      list.push({
        crackId,
        count: points.length,
        firstWidth: first ? first.widthMm : 0,
        latestWidth: latest ? latest.widthMm : 0,
        totalDelta: round((latest ? latest.widthMm : 0) - (first ? first.widthMm : 0), 2),
        rate,
        level: levelFromRate(rate),
        lastDate: latest ? latest.date : ''
      })
    })
    return list.sort((a, b) => b.rate - a.rate)
  })

  const rateMap = computed<Record<string, number>>(() => {
    const map: Record<string, number> = {}
    rates.value.forEach((item) => {
      map[item.crackId] = item.rate
    })
    return map
  })

  const levelMap = computed<Record<string, AdviceLevel>>(() => {
    const map: Record<string, AdviceLevel> = {}
    rates.value.forEach((item) => {
      map[item.crackId] = item.level
    })
    return map
  })

  const warningCrackIds = computed(() => rates.value.filter((item) => item.level !== '一般').map((item) => item.crackId))

  const summaryOf = (crackId: string): CrackRateSummary | null =>
    rates.value.find((item) => item.crackId === crackId) ?? null

  function setActiveCrack(id: string | null): void {
    activeCrackId.value = id
  }

  /**
   * 追加一次复测读数：自动取下一个测次序号并与前一次比对生成变化量。
   * 业务行与建档链首、裂缝读数同步更正，在同一事务提交。
   */
  async function createSurvey(draft: SurveyDraft): Promise<SurveyRow> {
    const now = Date.now()
    return db.transaction('rw', [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions], async (tx) => {
      const existing = (await db.surveys.where('crackId').equals(draft.crackId).toArray()).sort((a, b) => a.seq - b.seq)
      const previous = existing[existing.length - 1] ?? null
      const row: SurveyRow = {
        id: createId('sv'),
        crackId: draft.crackId,
        seq: previous ? previous.seq + 1 : 1,
        date: draft.date,
        widthMm: round(draft.widthMm, 2),
        lengthMm: Math.round(draft.lengthMm),
        deltaWidthMm: previous ? round(draft.widthMm - previous.widthMm, 2) : 0,
        surveyor: draft.surveyor.trim() || '未署名',
        createdAt: now,
        updatedAt: now,
        revision: ROW_REVISION
      }
      await db.surveys.put(row)
      await appendRevisionsInTx(tx, 'survey', [
        { before: null, after: row, source: REVISION_SOURCES.init, operator: row.surveyor, initial: true }
      ])
      await syncCrackToLatestInTx(tx, draft.crackId, row.surveyor)
      return row
    })
  }

  /** 编辑测次后重排序号并重算全部变化量；编辑本身与受影响测次均留更正链 */
  async function updateSurvey(id: string, draft: SurveyDraft): Promise<void> {
    await db.transaction('rw', [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions], async (tx) => {
      const before = await db.surveys.get(id)
      if (!before) return
      const surveyor = draft.surveyor.trim() || '未署名'
      const next: SurveyRow = {
        ...before,
        date: draft.date,
        widthMm: round(draft.widthMm, 2),
        lengthMm: Math.round(draft.lengthMm),
        surveyor,
        updatedAt: Date.now()
      }
      await db.surveys.put(next)
      await recalculateInTx(tx, draft.crackId, {
        editedId: id,
        editedBefore: before,
        editedAfter: next,
        operator: surveyor
      })
    })
  }

  /** 删除测次：先追加删除墓碑，再前移序号重算 */
  async function removeSurvey(id: string): Promise<void> {
    await db.transaction('rw', [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions], async (tx) => {
      const row = await db.surveys.get(id)
      if (!row) return
      await appendTombstoneInTx(tx, 'survey', row, {
        source: REVISION_SOURCES.delete,
        operator: row.surveyor
      })
      await db.surveys.delete(id)
      await recalculateInTx(tx, row.crackId, { operator: row.surveyor })
    })
  }

  interface RecalcOptions {
    /** 触发本次重算的编辑测次（编辑留痕复用，避免重复记一条） */
    editedId?: string
    editedBefore?: SurveyRow
    editedAfter?: SurveyRow
    operator?: string
  }

  /** 事务内：重排某裂缝测次序号、按日期顺序重算变化量，并对受影响测次追加更正链 */
  async function recalculateInTx(tx: Transaction, crackId: string, options: RecalcOptions = {}): Promise<void> {
    const rows = (await db.surveys.where('crackId').equals(crackId).toArray()).sort((a, b) =>
      a.date === b.date ? a.seq - b.seq : a.date.localeCompare(b.date)
    )
    const beforeMap = new Map(rows.map((row) => [row.id, row]))
    const now = Date.now()
    const recalculated = rows.map((row, index) => {
      const previous = index === 0 ? null : rows[index - 1]
      return {
        ...row,
        seq: index + 1,
        deltaWidthMm: previous ? round(row.widthMm - previous.widthMm, 2) : 0,
        updatedAt: row.id === options.editedId ? row.updatedAt : now
      }
    })

    const items: Array<{
      before: SurveyRow
      after: SurveyRow
      source: string
      operator: string
    }> = []
    for (const after of recalculated) {
      const before =
        after.id === options.editedId && options.editedBefore
          ? options.editedBefore
          : beforeMap.get(after.id) ?? after
      const source = after.id === options.editedId ? REVISION_SOURCES.correct : REVISION_SOURCES.reseq
      if (after.seq !== before.seq || after.deltaWidthMm !== before.deltaWidthMm || after.id === options.editedId) {
        // 编辑测次本身字段无变化时由修订服务去重；重排仅影响序号/变化量，没变化的不记
        items.push({ before, after, source, operator: options.operator ?? '现场班组' })
      }
    }
    if (recalculated.length > 0) await db.surveys.bulkPut(recalculated)
    if (items.length > 0) {
      await appendRevisionsInTx(tx, 'survey', items)
    }
    await syncCrackToLatestInTx(tx, crackId, options.operator)
  }

  /** 事务内：把裂缝台账宽长同步为最新测次读数，宽度/长度确有变化才追加更正 */
  async function syncCrackToLatestInTx(tx: Transaction, crackId: string, operator?: string): Promise<void> {
    const rows = (await db.surveys.where('crackId').equals(crackId).toArray()).sort((a, b) => a.seq - b.seq)
    const latest = rows[rows.length - 1]
    if (!latest) return
    const crack = await db.cracks.get(crackId)
    if (!crack) return
    if (crack.widthMm === latest.widthMm && crack.lengthMm === latest.lengthMm) return
    const next = { ...crack, widthMm: latest.widthMm, lengthMm: latest.lengthMm, updatedAt: Date.now() }
    await db.cracks.put(next)
    await appendRevisionsInTx(tx, 'crack', [
      { before: crack, after: next, source: REVISION_SOURCES.surveySync, operator: operator ?? latest.surveyor }
    ])
  }

  /** 保留给页面/外部的非事务重算入口（一般流程内部已调用） */
  async function recalculate(crackId: string): Promise<void> {
    await db.transaction('rw', [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.revisions], async (tx) => {
      await recalculateInTx(tx, crackId)
    })
  }

  return {
    surveyTable,
    surveys,
    rates,
    rateMap,
    levelMap,
    warningCrackIds,
    activeCrackId,
    surveysOf,
    summaryOf,
    setActiveCrack,
    createSurvey,
    updateSurvey,
    removeSurvey,
    recalculate
  }
})
