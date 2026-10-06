/** 区间：地铁运营线路中一个连续的结构区段 */
export type StructureType = '盾构' | '明挖' | '矿山法'

export interface Section {
  id: string
  /** 线路名，如「1号线」 */
  line: string
  /** 起始里程（m） */
  startMileage: number
  /** 终止里程（m） */
  endMileage: number
  structureType: StructureType
  /** 环数 */
  ringCount: number
  createdAt: number
  updatedAt: number
}

export const STRUCTURE_TYPES: StructureType[] = ['盾构', '明挖', '矿山法']

/** 新建/编辑区间表单入参 */
export interface SectionDraft {
  line: string
  startMileage: number
  endMileage: number
  structureType: StructureType
  ringCount: number
}

export const EMPTY_SECTION_DRAFT: SectionDraft = {
  line: '',
  startMileage: 0,
  endMileage: 0,
  structureType: '盾构',
  ringCount: 0
}

/** 区间卡片回显用的聚合值：环片数、裂缝总数、预警数 */
export interface SectionStat {
  sectionId: string
  ringCount: number
  crackCount: number
  warningCount: number
  /** 预警裂缝占比，0-100 的整数 */
  warningPercent: number
}

/** 里程格式化：12300 → K12+300 */
export function formatMileage(mileage: number): string {
  if (!Number.isFinite(mileage) || mileage < 0) return '—'
  const km = Math.floor(mileage / 1000)
  const rest = Math.round(mileage - km * 1000)
  return `K${String(km).padStart(2, '0')}+${String(rest).padStart(3, '0')}`
}

/** 区间跨度（m） */
export function sectionSpan(section: Section): number {
  return Math.max(0, Math.round(section.endMileage - section.startMileage))
}
