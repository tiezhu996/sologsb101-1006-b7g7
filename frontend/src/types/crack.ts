/** 裂缝：环片结构上的单条裂缝档案 */
export type CrackPosition = '拱顶' | '侧墙' | '道床'
export type CrackDirection = '纵向' | '环向' | '斜向'
export type CrackState = '观察' | '待整治' | '已整治'

export interface Crack {
  id: string
  ringId: string
  /** 冗余区间 id，便于按区间快速筛选与统计 */
  sectionId: string
  /** 裂缝编号，如 SL-118-01 */
  code: string
  position: CrackPosition
  direction: CrackDirection
  /** 初测宽度（mm） */
  widthMm: number
  /** 初测长度（mm） */
  lengthMm: number
  state: CrackState
  createdAt: number
  updatedAt: number
}

export const CRACK_POSITIONS: CrackPosition[] = ['拱顶', '侧墙', '道床']
export const CRACK_DIRECTIONS: CrackDirection[] = ['纵向', '环向', '斜向']
export const CRACK_STATES: CrackState[] = ['观察', '待整治', '已整治']

/** 裂缝状态推进顺序：观察 → 待整治 → 已整治 */
export const CRACK_STATE_FLOW: Record<CrackState, CrackState | null> = {
  观察: '待整治',
  待整治: '已整治',
  已整治: null
}

export interface CrackDraft {
  ringId: string
  code: string
  position: CrackPosition
  direction: CrackDirection
  widthMm: number
  lengthMm: number
  state: CrackState
}

export const EMPTY_CRACK_DRAFT: CrackDraft = {
  ringId: '',
  code: '',
  position: '拱顶',
  direction: '纵向',
  widthMm: 0,
  lengthMm: 0,
  state: '观察'
}

/** 裂缝列表筛选条件（存于 crackStore，与 URL query 同步） */
export interface CrackFilterState {
  keyword: string
  lines: string[]
  positions: CrackPosition[]
  directions: CrackDirection[]
  states: CrackState[]
  sectionId: string
}

export function createEmptyCrackFilter(): CrackFilterState {
  return { keyword: '', lines: [], positions: [], directions: [], states: [], sectionId: '' }
}
