/** 整治建议：由裂缝发展速率分级带出，人工确认后下发 */
export type AdviceLevel = '一般' | '较重' | '严重'
export type AdviceMeasure = '观测' | '注浆' | '嵌缝' | '钢板带'
export type AdviceState = '待下发' | '已下发' | '已完成'

export interface Advice {
  id: string
  crackId: string
  level: AdviceLevel
  measure: AdviceMeasure
  /** 判定依据 */
  basis: string
  state: AdviceState
  createdAt: number
  updatedAt: number
}

export const ADVICE_LEVELS: AdviceLevel[] = ['一般', '较重', '严重']
export const ADVICE_MEASURES: AdviceMeasure[] = ['观测', '注浆', '嵌缝', '钢板带']
export const ADVICE_STATES: AdviceState[] = ['待下发', '已下发', '已完成']

/** 建议状态机：待下发 → 已下发 → 已完成 */
export const ADVICE_STATE_FLOW: Record<AdviceState, AdviceState | null> = {
  待下发: '已下发',
  已下发: '已完成',
  已完成: null
}

/** 依据速率等级自动带出的措施建议 */
export const LEVEL_MEASURE_SUGGEST: Record<AdviceLevel, AdviceMeasure> = {
  一般: '观测',
  较重: '嵌缝',
  严重: '钢板带'
}

export interface AdviceDraft {
  crackId: string
  level: AdviceLevel
  measure: AdviceMeasure
  basis: string
  state: AdviceState
}

export const EMPTY_ADVICE_DRAFT: AdviceDraft = {
  crackId: '',
  level: '一般',
  measure: '观测',
  basis: '',
  state: '待下发'
}
