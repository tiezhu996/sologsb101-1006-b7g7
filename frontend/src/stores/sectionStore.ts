/**
 * 区间与环片状态（Pinia）
 * 维护区间/环片列表、当前选中区间与里程筛选条件。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  db,
  createId,
  deleteRingCascade,
  deleteSectionCascade,
  readUiPrefs,
  writeUiPrefs,
  ROW_REVISION,
  type RingRow,
  type SectionRow
} from '@/utils/db'
import { createEntity, correctEntity } from '@/utils/revisionService'
import { REVISION_SOURCES } from '@/types/revision'
import {
  STRUCTURE_TYPES,
  formatMileage,
  sectionSpan,
  type Section,
  type SectionDraft,
  type StructureType
} from '@/types/section'
import { SEGMENT_TYPES, type Ring, type RingDraft } from '@/types/ring'

export interface RingEnriched {
  ring: Ring
  section: Section | null
  /** 环号展示文案 */
  label: string
  mileageText: string
}

export const useSectionStore = defineStore('section', () => {
  const sectionTable = useIdbTable<SectionRow>((database) => database.sections, { sortByUpdatedAt: false })
  const ringTable = useIdbTable<RingRow>((database) => database.rings, { sortByUpdatedAt: false })

  const prefs = readUiPrefs()
  const currentSectionId = ref<string | null>(prefs.lastSectionId)
  const keyword = ref('')
  const structureTypes = ref<StructureType[]>([])
  const mileageFrom = ref<number | null>(null)
  const mileageTo = ref<number | null>(null)

  /* ------------------------------ 区间 ------------------------------ */

  const sections = computed<SectionRow[]>(() =>
    [...sectionTable.rows.value].sort((a, b) => {
      const lineDiff = a.line.localeCompare(b.line, 'zh-Hans-CN')
      if (lineDiff !== 0) return lineDiff
      return a.startMileage - b.startMileage
    })
  )

  const filteredSections = computed<SectionRow[]>(() => {
    const text = keyword.value.trim().toLowerCase()
    return sections.value.filter((section) => {
      if (structureTypes.value.length > 0 && !structureTypes.value.includes(section.structureType)) return false
      if (text.length === 0) return true
      return (
        section.line.toLowerCase().includes(text) ||
        formatMileage(section.startMileage).toLowerCase().includes(text) ||
        formatMileage(section.endMileage).toLowerCase().includes(text)
      )
    })
  })

  const currentSection = computed<SectionRow | null>(
    () => sections.value.find((section) => section.id === currentSectionId.value) ?? null
  )

  const lineOptions = computed(() =>
    Array.from(new Set(sections.value.map((section) => section.line))).map((line) => ({ label: line, value: line }))
  )

  async function selectSection(id: string | null): Promise<void> {
    currentSectionId.value = id
    writeUiPrefs({ ...readUiPrefs(), lastSectionId: id })
    await Promise.resolve()
  }

  async function createSection(draft: SectionDraft): Promise<SectionRow> {
    const now = Date.now()
    const row = (await createEntity(
      'section',
      {
        id: createId('sec'),
        line: draft.line.trim(),
        startMileage: Math.max(0, Math.round(draft.startMileage)),
        endMileage: Math.max(0, Math.round(draft.endMileage)),
        structureType: draft.structureType,
        ringCount: Math.max(0, Math.round(draft.ringCount)),
        createdAt: now,
        updatedAt: now,
        revision: ROW_REVISION
      },
      { source: REVISION_SOURCES.init }
    )) as SectionRow
    await selectSection(row.id)
    return row
  }

  async function updateSection(id: string, patch: Partial<SectionDraft>): Promise<void> {
    const next: Partial<SectionRow> = { ...patch }
    if (patch.line !== undefined) next.line = patch.line.trim()
    if (patch.startMileage !== undefined) next.startMileage = Math.max(0, Math.round(patch.startMileage))
    if (patch.endMileage !== undefined) next.endMileage = Math.max(0, Math.round(patch.endMileage))
    if (patch.ringCount !== undefined) next.ringCount = Math.max(0, Math.round(patch.ringCount))
    await correctEntity('section', id, { ...next, updatedAt: Date.now() }, { source: REVISION_SOURCES.correct })
  }

  async function removeSection(id: string): Promise<void> {
    await deleteSectionCascade(id)
    if (currentSectionId.value === id) {
      const fallback = sections.value.find((section) => section.id !== id) ?? null
      await selectSection(fallback ? fallback.id : null)
    }
  }

  /* ------------------------------ 环片 ------------------------------ */

  const rings = computed<RingRow[]>(() =>
    [...ringTable.rows.value].sort((a, b) => a.mileage - b.mileage || a.ringNo - b.ringNo)
  )

  const ringsOfSection = computed<RingRow[]>(() =>
    currentSectionId.value === null ? rings.value : rings.value.filter((ring) => ring.sectionId === currentSectionId.value)
  )

  const enrichedRings = computed<RingEnriched[]>(() =>
    ringsOfSection.value.map((ring) => ({
      ring,
      section: sections.value.find((section) => section.id === ring.sectionId) ?? null,
      label: `第 ${ring.ringNo} 环`,
      mileageText: formatMileage(ring.mileage)
    }))
  )

  const filteredRings = computed<RingEnriched[]>(() => {
    const text = keyword.value.trim().toLowerCase()
    return enrichedRings.value.filter((item) => {
      const { ring } = item
      if (mileageFrom.value !== null && ring.mileage < mileageFrom.value) return false
      if (mileageTo.value !== null && ring.mileage > mileageTo.value) return false
      if (text.length === 0) return true
      return (
        String(ring.ringNo).includes(text) ||
        ring.segmentType.toLowerCase().includes(text) ||
        item.mileageText.toLowerCase().includes(text)
      )
    })
  })

  function setMileageRange(from: number | null, to: number | null): void {
    mileageFrom.value = from
    mileageTo.value = to
  }

  function setStructureTypes(values: StructureType[]): void {
    structureTypes.value = values
  }

  function resetFilter(): void {
    keyword.value = ''
    structureTypes.value = []
    mileageFrom.value = null
    mileageTo.value = null
  }

  async function createRing(draft: RingDraft): Promise<RingRow> {
    const now = Date.now()
    const row = (await createEntity(
      'ring',
      {
        id: createId('ring'),
        sectionId: draft.sectionId || currentSectionId.value || '',
        ringNo: Math.max(0, Math.round(draft.ringNo)),
        mileage: Math.max(0, Math.round(draft.mileage)),
        segmentType: draft.segmentType,
        installDate: draft.installDate,
        createdAt: now,
        updatedAt: now,
        revision: ROW_REVISION
      },
      { source: REVISION_SOURCES.init }
    )) as RingRow
    return row
  }

  async function updateRing(id: string, patch: Partial<RingDraft>): Promise<void> {
    const next: Partial<RingRow> = { ...patch }
    if (patch.ringNo !== undefined) next.ringNo = Math.max(0, Math.round(patch.ringNo))
    if (patch.mileage !== undefined) next.mileage = Math.max(0, Math.round(patch.mileage))
    await correctEntity('ring', id, { ...next, updatedAt: Date.now() }, { source: REVISION_SOURCES.correct })
  }

  async function removeRing(id: string): Promise<void> {
    await deleteRingCascade(id)
  }

  /** 区间跨度合计（页头展示） */
  const totalSpan = computed(() => sections.value.reduce((sum, section) => sum + sectionSpan(section), 0))

  /** 供其它 store 复用的索引 */
  const sectionById = computed(() => new Map(sections.value.map((section) => [section.id, section])))
  const ringById = computed(() => new Map(rings.value.map((ring) => [ring.id, ring])))

  return {
    sectionTable,
    ringTable,
    sections,
    filteredSections,
    rings,
    ringsOfSection,
    enrichedRings,
    filteredRings,
    currentSectionId,
    currentSection,
    lineOptions,
    keyword,
    structureTypes,
    mileageFrom,
    mileageTo,
    structureTypeOptions: STRUCTURE_TYPES,
    segmentTypeOptions: SEGMENT_TYPES,
    totalSpan,
    sectionById,
    ringById,
    selectSection,
    createSection,
    updateSection,
    removeSection,
    createRing,
    updateRing,
    removeRing,
    setMileageRange,
    setStructureTypes,
    resetFilter,
    /** 直连 Dexie 供页面做单条查询 */
    getRing: (id: string) => db.rings.get(id)
  }
})
