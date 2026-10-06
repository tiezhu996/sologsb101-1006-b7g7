/**
 * 裂缝状态（Pinia）
 * 维护裂缝列表、部位/走向/状态筛选条件与统计派生值。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { createId, deleteCrackCascade, readUiPrefs, writeUiPrefs, ROW_REVISION, type CrackRow } from '@/utils/db'
import { bulkCorrectEntities, correctEntity, createEntity } from '@/utils/revisionService'
import { REVISION_SOURCES } from '@/types/revision'
import type { Crack, CrackDraft, CrackFilterState, CrackPosition, CrackDirection, CrackState } from '@/types/crack'
import { createEmptyCrackFilter, CRACK_DIRECTIONS, CRACK_POSITIONS, CRACK_STATES } from '@/types/crack'
import type { AdviceLevel } from '@/types/advice'
import type { Ring } from '@/types/ring'
import { useSectionStore } from '@/stores/sectionStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { formatMileage } from '@/types/section'
import type { Section } from '@/types/section'
import { round } from '@/utils/rate'

/** 裂缝行（附所属环片/区间与最新发展态势） */
export interface CrackEnriched {
  crack: Crack
  ring: Ring | null
  section: Section | null
  ringLabel: string
  sectionLabel: string
  rate: number
  level: AdviceLevel
  surveyCount: number
}

export const useCrackStore = defineStore('crack', () => {
  const crackTable = useIdbTable<CrackRow>((database) => database.cracks, { sortByUpdatedAt: false })
  const sectionStore = useSectionStore()
  const surveyStore = useSurveyStore()

  const filter = ref<CrackFilterState>(createEmptyCrackFilter())
  const selectedIds = ref<string[]>([])
  /** 速率分级页的「仅看预警」开关，跨页持久化到 localStorage */
  const onlyWarning = ref(readUiPrefs().trendOnlyWarning)

  const cracks = computed<CrackRow[]>(() =>
    [...crackTable.rows.value].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
  )

  const enriched = computed<CrackEnriched[]>(() =>
    cracks.value.map((crack) => {
      const ring = sectionStore.ringById.get(crack.ringId) ?? null
      const section = sectionStore.sectionById.get(crack.sectionId) ?? null
      const summary = surveyStore.summaryOf(crack.id)
      return {
        crack,
        ring,
        section,
        ringLabel: ring ? `第 ${ring.ringNo} 环` : '环片已删除',
        sectionLabel: section ? `${section.line} ${formatMileage(ring ? ring.mileage : section.startMileage)}` : '区间已删除',
        rate: summary ? summary.rate : 0,
        level: (summary ? summary.level : '一般') as AdviceLevel,
        surveyCount: summary ? summary.count : 0
      }
    })
  )

  const filtered = computed<CrackEnriched[]>(() => {
    const text = filter.value.keyword.trim().toLowerCase()
    return enriched.value.filter((item) => {
      const { crack, ring } = item
      if (filter.value.sectionId && crack.sectionId !== filter.value.sectionId) return false
      if (filter.value.positions.length > 0 && !filter.value.positions.includes(crack.position)) return false
      if (filter.value.directions.length > 0 && !filter.value.directions.includes(crack.direction)) return false
      if (filter.value.states.length > 0 && !filter.value.states.includes(crack.state)) return false
      if (filter.value.lines.length > 0) {
        const line = item.section ? item.section.line : ''
        if (!filter.value.lines.includes(line)) return false
      }
      if (text.length === 0) return true
      return (
        crack.code.toLowerCase().includes(text) ||
        item.ringLabel.toLowerCase().includes(text) ||
        item.sectionLabel.toLowerCase().includes(text) ||
        (ring ? String(ring.ringNo).includes(text) : false)
      )
    })
  })

  const stateCounts = computed<Record<CrackState, number>>(() => {
    const counts: Record<CrackState, number> = { 观察: 0, 待整治: 0, 已整治: 0 }
    cracks.value.forEach((crack) => {
      counts[crack.state] += 1
    })
    return counts
  })

  const positionCounts = computed<Record<CrackPosition, number>>(() => {
    const counts: Record<CrackPosition, number> = { 拱顶: 0, 侧墙: 0, 道床: 0 }
    cracks.value.forEach((crack) => {
      counts[crack.position] += 1
    })
    return counts
  })

  const directionCounts = computed<Record<CrackDirection, number>>(() => {
    const counts: Record<CrackDirection, number> = { 纵向: 0, 环向: 0, 斜向: 0 }
    cracks.value.forEach((crack) => {
      counts[crack.direction] += 1
    })
    return counts
  })

  /** 每个区间的裂缝数与预警数 */
  const sectionStats = computed<Record<string, { crackCount: number; warningCount: number }>>(() => {
    const stats: Record<string, { crackCount: number; warningCount: number }> = {}
    const warningSet = new Set(surveyStore.warningCrackIds)
    cracks.value.forEach((crack) => {
      const entry = stats[crack.sectionId] ?? { crackCount: 0, warningCount: 0 }
      entry.crackCount += 1
      if (warningSet.has(crack.id)) entry.warningCount += 1
      stats[crack.sectionId] = entry
    })
    return stats
  })

  const warningCount = computed(() => surveyStore.warningCrackIds.length)

  const warningPercent = computed(() =>
    cracks.value.length === 0 ? 0 : Math.round((warningCount.value / cracks.value.length) * 100)
  )

  const waitingCount = computed(() => stateCounts.value['待整治'])

  const averageWidth = computed(() => {
    if (cracks.value.length === 0) return 0
    const total = cracks.value.reduce((sum, crack) => sum + crack.widthMm, 0)
    return round(total / cracks.value.length, 2)
  })

  function patchFilter(patch: Partial<CrackFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyCrackFilter()
  }

  const hasFilter = computed(() => {
    const current = filter.value
    return (
      current.keyword.trim().length > 0 ||
      current.lines.length > 0 ||
      current.positions.length > 0 ||
      current.directions.length > 0 ||
      current.states.length > 0 ||
      current.sectionId.length > 0
    )
  })

  async function createCrack(draft: CrackDraft): Promise<CrackRow> {
    const ring = sectionStore.ringById.get(draft.ringId)
    const now = Date.now()
    const row = (await createEntity(
      'crack',
      {
        id: createId('crack'),
        ringId: draft.ringId,
        sectionId: ring ? ring.sectionId : '',
        code: draft.code.trim() || `SL-${Date.now().toString().slice(-5)}`,
        position: draft.position,
        direction: draft.direction,
        widthMm: round(draft.widthMm, 2),
        lengthMm: Math.round(draft.lengthMm),
        state: draft.state,
        createdAt: now,
        updatedAt: now,
        revision: ROW_REVISION
      },
      { source: REVISION_SOURCES.init }
    )) as CrackRow
    return row
  }

  async function updateCrack(id: string, patch: Partial<CrackDraft>): Promise<void> {
    const next: Partial<CrackRow> = { ...patch }
    if (patch.code !== undefined) next.code = patch.code.trim()
    if (patch.widthMm !== undefined) next.widthMm = round(patch.widthMm, 2)
    if (patch.lengthMm !== undefined) next.lengthMm = Math.round(patch.lengthMm)
    if (patch.ringId !== undefined) {
      const ring = sectionStore.ringById.get(patch.ringId)
      if (ring) next.sectionId = ring.sectionId
    }
    await correctEntity('crack', id, { ...next, updatedAt: Date.now() }, { source: REVISION_SOURCES.correct })
  }

  async function removeCrack(id: string): Promise<void> {
    await deleteCrackCascade(id)
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
  }

  /** 批量改状态（勾选后一次生效）：逐条判定是否真有变化，无变化不多记 */
  async function bulkSetState(ids: string[], state: CrackState): Promise<void> {
    if (ids.length === 0) return
    const targets = cracks.value.filter((crack) => ids.includes(crack.id))
    await bulkCorrectEntities(
      'crack',
      targets,
      { state, updatedAt: Date.now() },
      { source: REVISION_SOURCES.stateFlow }
    )
    selectedIds.value = []
  }

  async function setState(id: string, state: CrackState): Promise<void> {
    await correctEntity('crack', id, { state, updatedAt: Date.now() }, { source: REVISION_SOURCES.stateFlow })
  }

  function toggleSelect(id: string, checked: boolean): void {
    selectedIds.value = checked
      ? Array.from(new Set([...selectedIds.value, id]))
      : selectedIds.value.filter((item) => item !== id)
  }

  function setSelectedIds(ids: string[]): void {
    selectedIds.value = [...ids]
  }

  function clearSelection(): void {
    selectedIds.value = []
  }

  function setOnlyWarning(value: boolean): void {
    onlyWarning.value = value
    writeUiPrefs({ ...readUiPrefs(), trendOnlyWarning: value })
  }

  return {
    crackTable,
    cracks,
    enriched,
    filtered,
    filter,
    selectedIds,
    onlyWarning,
    stateCounts,
    positionCounts,
    directionCounts,
    sectionStats,
    warningCount,
    warningPercent,
    waitingCount,
    averageWidth,
    hasFilter,
    positionOptions: CRACK_POSITIONS,
    directionOptions: CRACK_DIRECTIONS,
    stateOptions: CRACK_STATES,
    patchFilter,
    resetFilter,
    createCrack,
    updateCrack,
    removeCrack,
    bulkSetState,
    setState,
    toggleSelect,
    setSelectedIds,
    clearSelection,
    setOnlyWarning
  }
})
