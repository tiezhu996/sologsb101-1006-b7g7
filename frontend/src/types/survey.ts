/** 复测：对同一条裂缝按测次追加的读数记录 */
export interface Survey {
  id: string
  crackId: string
  /** 测次序号，从 1 开始 */
  seq: number
  /** 复测日期 YYYY-MM-DD */
  date: string
  widthMm: number
  lengthMm: number
  /** 与上一次测次相比的宽度变化量（mm） */
  deltaWidthMm: number
  /** 复测人 */
  surveyor: string
  createdAt: number
  updatedAt: number
}

export interface SurveyDraft {
  crackId: string
  date: string
  widthMm: number
  lengthMm: number
  surveyor: string
}

export const EMPTY_SURVEY_DRAFT: SurveyDraft = {
  crackId: '',
  date: '',
  widthMm: 0,
  lengthMm: 0,
  surveyor: ''
}

/** 单个测次在折线图上的取点 */
export interface SurveyPoint {
  seq: number
  date: string
  widthMm: number
  lengthMm: number
  deltaWidthMm: number
  /** 该测次距上一测次的月均速率（mm/月） */
  rate: number
}
