/**
 * 修订链：与现场台账分离的留痕记录。
 * 区间、环片、裂缝、复测测次、整治建议每一次写入都会在 revisions 表追加一条：
 * 记录来源、前一条摘要与当前摘要；现场纠错只追加更正记录，绝不覆盖历史。
 */

/** 修订链覆盖的五类业务对象（与五张业务表一一对应） */
export const REVISION_ENTITIES = ['section', 'ring', 'crack', 'survey', 'advice'] as const
export type RevisionEntityType = (typeof REVISION_ENTITIES)[number]

export const REVISION_ENTITY_TEXT: Record<RevisionEntityType, string> = {
  section: '区间',
  ring: '环片',
  crack: '裂缝',
  survey: '复测测次',
  advice: '整治建议'
}

/**
 * 修订动作：
 * - init：现场建档（新写入第一条）
 * - correct：在既有链上追加更正（含状态流转、删除墓碑）
 * - backfill：旧数据升级 / 存档导入 / 延迟补建的初始链
 */
export type RevisionAction = 'init' | 'correct' | 'backfill'

export const REVISION_ACTION_TEXT: Record<RevisionAction, string> = {
  init: '初始建档',
  correct: '更正记录',
  backfill: '补建初始链'
}

/** 单条字段变更明细 */
export interface RevisionFieldChange {
  /** 字段名（业务模型字段） */
  field: string
  /** 字段中文名 */
  fieldLabel: string
  /** 变更前值（已格式化为文案），新增字段为 null */
  before: string | null
  /** 变更后值（已格式化为文案） */
  after: string | null
}

/** 修订链上的一条记录 */
export interface Revision {
  id: string
  entityType: RevisionEntityType
  /** 被修订的业务对象 id */
  entityId: string
  /** 同一对象链内序号，从 1 单调递增 */
  seq: number
  /** 前一条修订记录 id；链首为 null */
  prevId: string | null
  /** 写入来源（现场建档 / 现场纠错 / 旧数据升级补链 等） */
  source: string
  action: RevisionAction
  /** 前一条记录的内容摘要；链首为 null */
  prevSummary: string | null
  /** 本条写入后的内容摘要 */
  summary: string
  /** 本次更正的字段差异；建档 / 补链时为空数组 */
  changes: RevisionFieldChange[]
  /** 业务对象短标识（如裂缝编号、环号），对象被删除后仍可用于核对展示 */
  entityLabel: string
  /** 关联对象描述（所属区间 / 环片 / 裂缝） */
  relatedLabel: string
  /** 操作人 / 记录来源人 */
  operator: string
  /** 是否为删除墓碑：业务行已删除但链条保留供审计 */
  tombstone: boolean
  createdAt: number
}

/** 修订来源口径（全应用统一，禁止各页面自行编造） */
export const REVISION_SOURCES = {
  /** 新建业务记录 */
  init: '现场建档',
  /** 编辑表单保存的现场纠错 */
  correct: '现场纠错',
  /** 观察→待整治→已整治、待下发→已下发→已完成 */
  stateFlow: '状态流转',
  /** 追加复测后把裂缝宽长同步为最新读数 */
  surveySync: '复测最新读数同步',
  /** 测次编辑 / 删除后重排序号与变化量 */
  reseq: '测次顺序重算',
  /** 删除业务记录（保留链条墓碑） */
  delete: '台账记录删除',
  /** v2 → v3 结构升级时为旧数据补初始链 */
  backfill: '旧数据升级补链',
  /** 导入缺少修订链的旧存档时补初始链 */
  importBackfill: '存档导入补链',
  /** 对无链旧记录执行写入时顺带补建 */
  writeTimeBackfill: '写入时补建初始链',
  /** 演示播种 */
  seed: '演示数据初始建档'
} as const

/** 表单未提供操作人时的兜底署名 */
export const DEFAULT_OPERATOR = '现场班组'

/** 删除墓碑的当前摘要 */
export const TOMBSTONE_SUMMARY = '（该记录已从现场台账删除，链条保留备查）'

/** 修订链完整性核对结论 */
export type IntegrityIssueKind = 'unlinked-legacy' | 'broken-chain' | 'missing-content'

export const INTEGRITY_ISSUE_TEXT: Record<IntegrityIssueKind, string> = {
  /** 业务记录存在但从未建立修订链（旧记录未建链） */
  'unlinked-legacy': '旧记录未建链',
  /** prevId / prevSummary 与上一条接不上，或序号断裂 */
  'broken-chain': '链条断开',
  /** 首条摘要为空、链末摘要与台账当前内容对不上，或业务记录缺失 */
  'missing-content': '内容缺失'
}

export interface IntegrityIssue {
  entityType: RevisionEntityType
  entityId: string
  entityLabel: string
  relatedLabel: string
  kind: IntegrityIssueKind
  /** 第一条对不上的修订记录 id；未建链时为 null */
  revisionId: string | null
  /** 第一条摘要（链首摘要），便于审计直接核对 */
  firstSummary: string
  /** 链末摘要（当前应然内容） */
  lastSummary: string
  /** 问题说明 */
  detail: string
}

export interface IntegrityReport {
  issues: IntegrityIssue[]
  /** 业务对象总数 */
  entityTotal: number
  /** 已建链对象数 */
  linkedCount: number
  /** 修订记录总数 */
  revisionCount: number
  scannedAt: number
}
