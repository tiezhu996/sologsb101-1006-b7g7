/**
 * 复测测次状态（Pinia）
 * 维护测次顺序、变化量缓存与按裂缝汇总的发展速率。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type SurveyRow } from '@/utils/db'
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
   * 追加一次复测读数：自动取下一个测次序号并与前一次比对生成变化量
   */
  async function createSurvey(draft: SurveyDraft): Promise<SurveyRow> {
    const existing = surveysOf(draft.crackId)
    const previous = existing.length > 0 ? existing[existing.length - 1] : null
    const seq = previous ? previous.seq + 1 : 1
    const delta = previous ? round(draft.widthMm - previous.widthMm, 2) : 0
    const row = (await surveyTable.create(
      {
        crackId: draft.crackId,
        seq,
        date: draft.date,
        widthMm: round(draft.widthMm, 2),
        lengthMm: Math.round(draft.lengthMm),
        deltaWidthMm: delta,
        surveyor: draft.surveyor.trim() || '未署名'
      },
      'sv'
    )) as SurveyRow
    await syncCrackToLatest(draft.crackId)
    return row
  }

  /** 编辑测次后重排序号并重算全部变化量 */
  async function updateSurvey(id: string, draft: SurveyDraft): Promise<void> {
    const row = surveyTable.rows.value.find((item) => item.id === id)
    if (!row) return
    await surveyTable.update(id, {
      date: draft.date,
      widthMm: round(draft.widthMm, 2),
      lengthMm: Math.round(draft.lengthMm),
      surveyor: draft.surveyor.trim() || '未署名'
    })
    await recalculate(draft.crackId)
  }

  async function removeSurvey(id: string): Promise<void> {
    const row = surveyTable.rows.value.find((item) => item.id === id)
    if (!row) return
    await surveyTable.remove(id)
    await recalculate(row.crackId)
  }

  /** 重排某条裂缝的测次序号，并按日期顺序重算变化量 */
  async function recalculate(crackId: string): Promise<void> {
    const rows = (await db.surveys.where('crackId').equals(crackId).toArray()).sort((a, b) =>
      a.date === b.date ? a.seq - b.seq : a.date.localeCompare(b.date)
    )
    const patches = rows.map((row, index) => {
      const previous = index === 0 ? null : rows[index - 1]
      return {
        ...row,
        seq: index + 1,
        deltaWidthMm: previous ? round(row.widthMm - previous.widthMm, 2) : 0,
        updatedAt: Date.now()
      }
    })
    if (patches.length > 0) await db.surveys.bulkPut(patches)
    await syncCrackToLatest(crackId)
  }

  /** 把裂缝台账上的宽度/长度同步为最新测次读数 */
  async function syncCrackToLatest(crackId: string): Promise<void> {
    const rows = (await db.surveys.where('crackId').equals(crackId).toArray()).sort((a, b) => a.seq - b.seq)
    const latest = rows[rows.length - 1]
    if (!latest) return
    await db.cracks.update(crackId, { widthMm: latest.widthMm, lengthMm: latest.lengthMm, updatedAt: Date.now() })
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
