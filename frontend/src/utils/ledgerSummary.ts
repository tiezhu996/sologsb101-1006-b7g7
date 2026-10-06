/**
 * 台账内容摘要（纯函数）
 *
 * 修订链的「当前摘要 / 前一条摘要」由这里按统一口径生成；
 * 摘要只覆盖审计关心的跟踪字段，不含 createdAt/updatedAt 等元数据。
 * 旧数据缺字段时以「缺失」标注，审计据此判为内容缺失而非篡改。
 */
import type { Section } from '@/types/section'
import type { Ring } from '@/types/ring'
import type { Crack } from '@/types/crack'
import type { Survey } from '@/types/survey'
import type { Advice } from '@/types/advice'
import { formatMileage } from '@/types/section'
import type { RevisionEntityType } from '@/types/revision'

export type LedgerRow = Section | Ring | Crack | Survey | Advice

/** 各实体纳入修订链跟踪的字段（及其中文名），顺序即摘要呈现顺序 */
export const TRACKED_FIELDS: Record<RevisionEntityType, Array<{ key: string; label: string }>> = {
  section: [
    { key: 'line', label: '线路' },
    { key: 'startMileage', label: '起里程' },
    { key: 'endMileage', label: '止里程' },
    { key: 'structureType', label: '结构型式' },
    { key: 'ringCount', label: '环数' }
  ],
  ring: [
    { key: 'sectionId', label: '所属区间' },
    { key: 'ringNo', label: '环号' },
    { key: 'mileage', label: '里程' },
    { key: 'segmentType', label: '管片型式' },
    { key: 'installDate', label: '安装日期' }
  ],
  crack: [
    { key: 'ringId', label: '所属环片' },
    { key: 'code', label: '裂缝编号' },
    { key: 'position', label: '部位' },
    { key: 'direction', label: '走向' },
    { key: 'widthMm', label: '宽度(mm)' },
    { key: 'lengthMm', label: '长度(mm)' },
    { key: 'state', label: '状态' }
  ],
  survey: [
    { key: 'crackId', label: '所属裂缝' },
    { key: 'seq', label: '测次' },
    { key: 'date', label: '复测日期' },
    { key: 'widthMm', label: '宽度(mm)' },
    { key: 'lengthMm', label: '长度(mm)' },
    { key: 'deltaWidthMm', label: '变化量(mm)' },
    { key: 'surveyor', label: '复测人' }
  ],
  advice: [
    { key: 'crackId', label: '所属裂缝' },
    { key: 'level', label: '等级' },
    { key: 'measure', label: '措施' },
    { key: 'basis', label: '判定依据' },
    { key: 'state', label: '状态' }
  ]
}

/** 缺失值在摘要中的统一写法 */
export const MISSING_TEXT = '缺失'

function fieldText(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return MISSING_TEXT
  switch (key) {
    case 'startMileage':
    case 'endMileage':
    case 'mileage':
      return typeof value === 'number' && Number.isFinite(value) ? formatMileage(value) : MISSING_TEXT
    case 'widthMm':
    case 'deltaWidthMm':
      return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : MISSING_TEXT
    case 'lengthMm':
      return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : MISSING_TEXT
    case 'ringNo':
    case 'ringCount':
    case 'seq':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : MISSING_TEXT
    case 'sectionId':
    case 'ringId':
    case 'crackId':
      return typeof value === 'string' && value.length > 0 ? value : MISSING_TEXT
    default:
      return String(value)
  }
}

/**
 * 抽取实体的跟踪字段快照（原值保留，数值仍为 number）。
 * 旧数据没有的键显式置为 null，审计按 null 判内容缺失，绝不臆造。
 */
export function trackedSnapshot(entityType: RevisionEntityType, row: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}
  TRACKED_FIELDS[entityType].forEach(({ key }) => {
    snapshot[key] = Object.prototype.hasOwnProperty.call(row, key) ? row[key] : null
  })
  return snapshot
}

/** 由快照（或活行）生成一条「字段名=值」式摘要 */
export function summaryOf(
  entityType: RevisionEntityType,
  source: Record<string, unknown>,
  subject?: string
): string {
  const parts = TRACKED_FIELDS[entityType].map(
    ({ key, label }) => `${label} ${fieldText(key, source[key])}`
  )
  return subject ? `${subject}｜${parts.join('，')}` : parts.join('，')
}

/** 某条修订记录当前摘要（以自身快照为准） */
export function revisionSummary(
  entityType: RevisionEntityType,
  snapshot: Record<string, unknown>,
  subject?: string
): string {
  return summaryOf(entityType, snapshot, subject)
}

/** 单字段变化文案：「宽度(mm) 0.42 → 0.55」；缺失时写 旧值/新值 缺失 */
export function describeChange(
  entityType: RevisionEntityType,
  key: string,
  before: unknown,
  after: unknown
): string {
  const label = TRACKED_FIELDS[entityType].find((field) => field.key === key)?.label ?? key
  return `${label} ${fieldText(key, before)} → ${fieldText(key, after)}`
}

/** 列出两个快照之间发生变化的跟踪字段 */
export function changedKeys(
  entityType: RevisionEntityType,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  return TRACKED_FIELDS[entityType]
    .map(({ key }) => key)
    .filter((key) => normalize(before[key]) !== normalize(after[key]))
}

/** 比较用归一化：数字按四舍五入到 2 位，其余按字符串（null/undefined/'' 统一为空） */
function normalize(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : ''
  return String(value)
}

/**
 * 生成更正记录的字段变化汇总：
 * 多条用「；」连接，形如「宽度(mm) 0.42 → 0.55；状态 观察 → 待整治」
 */
export function describeChanges(
  entityType: RevisionEntityType,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: string[]
): string {
  return keys.map((key) => describeChange(entityType, key, before[key], after[key])).join('；')
}
