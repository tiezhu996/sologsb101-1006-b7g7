/**
 * 修订链（审计留痕）类型定义
 *
 * 现场台账（sections/rings/cracks/surveys/advices）保存当前值；
 * revisions 表只追加保存每次写入的来源、前一条摘要与当前摘要，
 * 纠错不会盖掉旧值——旧值保留在上一条修订的 snapshot 中。
 */

/** 纳入修订链管理的台账对象类型 */
export const REVISION_ENTITY_TYPES = ['section', 'ring', 'crack', 'survey', 'advice'] as const
export type RevisionEntityType = (typeof REVISION_ENTITY_TYPES)[number]

/** 实体类型 → IndexedDB 业务表名 */
export const ENTITY_TABLE_NAME: Record<RevisionEntityType, string> = {
  section: 'sections',
  ring: 'rings',
  crack: 'cracks',
  survey: 'surveys',
  advice: 'advices'
}

/** 实体类型中文标签（核对页/修订链展示） */
export const ENTITY_TYPE_LABEL: Record<RevisionEntityType, string> = {
  section: '区间',
  ring: '环片',
  crack: '裂缝',
  survey: '复测测次',
  advice: '整治建议'
}

/** 修订条目类型：初始记录（建账/补链）或更正记录（纠错追加） */
export type RevisionKind = 'initial' | 'correction'

export const REVISION_KIND_LABEL: Record<RevisionKind, string> = {
  initial: '初始记录',
  correction: '更正记录'
}

/**
 * 一条修订链记录（只追加，不允许就地改写）。
 * 同一实体按 seq 从 1 递增，correction 的 prevId/prevSummary 指向上一条。
 */
export interface RevisionRecord {
  id: string
  entityType: RevisionEntityType
  entityId: string
  /** 链内序号，从 1 开始连续编号 */
  seq: number
  kind: RevisionKind
  /** 写入来源（现场录入 / 现场纠错 / 系统重算 / 旧数据升级补链 等） */
  source: string
  /** 动作简述：初始建账 / 现场纠错 / 系统同步 …… */
  action: string
  /** 上一条修订 id；首条为 null */
  prevId: string | null
  /** 上一条当前摘要；首条为 null */
  prevSummary: string | null
  /** 本条写入后的当前摘要 */
  summary: string
  /** 本条覆盖的跟踪字段值快照；首条可据其复算摘要，更正条留存写后值 */
  snapshot: Record<string, unknown>
  /** 本条涉及的跟踪字段名 */
  fields: string[]
  /** 更正记录的字段变化文案：「宽度 0.42 → 0.55」 */
  changedSummary?: string
  /** 业务发生时间（沿用实体 createdAt / 写入时刻） */
  createdAt: number
  /** 修订落链时间 */
  recordedAt: number
}

/** 写入上下文：每次写台账都必须声明来源 */
export interface WriteContext {
  /** 来源说明 */
  source: string
  /** 动作简述，缺省按 初始建账 / 现场纠错 推导 */
  action?: string
}

/** 固定来源，保证同一类动作全系统口径一致 */
export const REVISION_SOURCE = {
  /** v3 结构升级时为旧数据补初始链 */
  migration: '旧数据升级（按当时内容补初始链，缺失不算篡改）',
  /** 演示数据播种 */
  seed: '演示数据播种（初始建账）',
  /** 核对页对未建链旧记录补初始链 */
  auditBackfill: '审计核对补链（按当时内容补初始链）',
  /** 导入旧版存档（无修订链）时补初始链 */
  importBackfill: '存档导入（按当时内容补初始链）',
  /** 复测追加后把裂缝台账同步为最新读数 */
  surveySync: '系统同步：复测追加后回写裂缝最新读数',
  /** 编辑/删除测次后重排序号、重算变化量 */
  surveyRecalc: '系统重算：测次序号与变化量'
} as const
