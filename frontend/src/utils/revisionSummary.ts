/**
 * 修订链摘要与字段差异：纯函数，不触碰 IndexedDB。
 * 摘要口径全应用统一，核对页据此比对「第一条摘要」与台账当前内容。
 */
import type { Section } from '@/types/section'
import type { Ring } from '@/types/ring'
import type { Crack } from '@/types/crack'
import type { Survey } from '@/types/survey'
import type { Advice } from '@/types/advice'
import { formatMileage } from '@/types/section'
import type { RevisionEntityType, RevisionFieldChange } from '@/types/revision'

/** 内容摘要里缺失字段的占位文案：升级补链时字段缺失按缺失呈现，不算篡改 */
export const MISSING_TOKEN = '缺失'

export type BusinessRow = Section | Ring | Crack | Survey | Advice

/** 纳入审计摘要的字段及顺序（id / 外键 / 时间戳 / 行 revision 不参与摘要） */
export const AUDIT_FIELDS: Record<RevisionEntityType, string[]> = {
  section: ['line', 'startMileage', 'endMileage', 'structureType', 'ringCount'],
  ring: ['ringNo', 'mileage', 'segmentType', 'installDate'],
  crack: ['code', 'position', 'direction', 'widthMm', 'lengthMm', 'state'],
  survey: ['seq', 'date', 'widthMm', 'lengthMm', 'deltaWidthMm', 'surveyor'],
  advice: ['level', 'measure', 'basis', 'state']
}

export const FIELD_LABELS: Record<RevisionEntityType, Record<string, string>> = {
  section: {
    line: '线路',
    startMileage: '起始里程',
    endMileage: '终止里程',
    structureType: '结构型式',
    ringCount: '环数'
  },
  ring: {
    ringNo: '环号',
    mileage: '里程',
    segmentType: '管片型式',
    installDate: '安装日期'
  },
  crack: {
    code: '裂缝编号',
    position: '部位',
    direction: '走向',
    widthMm: '宽度(mm)',
    lengthMm: '长度(mm)',
    state: '状态'
  },
  survey: {
    seq: '测次',
    date: '复测日期',
    widthMm: '宽度(mm)',
    lengthMm: '长度(mm)',
    deltaWidthMm: '变化量(mm)',
    surveyor: '复测人'
  },
  advice: {
    level: '建议等级',
    measure: '建议措施',
    basis: '判定依据',
    state: '状态'
  }
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  return true
}

/** 字段值 → 摘要文案；缺失统一为「缺失」 */
export function formatAuditValue(field: string, value: unknown): string {
  if (!isPresent(value)) return MISSING_TOKEN
  if (field === 'startMileage' || field === 'endMileage' || field === 'mileage') {
    return formatMileage(Number(value))
  }
  if (field === 'seq') return `第${Number(value)}测次`
  if (typeof value === 'number') return String(value)
  return String(value)
}

/** 业务对象短标识（对象删除后链条仍可辨认） */
export function businessLabel(entityType: RevisionEntityType, row: Partial<BusinessRow>): string {
  switch (entityType) {
    case 'section': {
      const r = row as Partial<Section>
      return isPresent(r.line) ? `${r.line} ${formatMileage(Number(r.startMileage))}～${formatMileage(Number(r.endMileage))}` : '未命名区间'
    }
    case 'ring': {
      const r = row as Partial<Ring>
      return isPresent(r.ringNo) ? `第${r.ringNo}环` : '未编号环片'
    }
    case 'crack': {
      const r = row as Partial<Crack>
      return isPresent(r.code) ? String(r.code) : '未编号裂缝'
    }
    case 'survey': {
      const r = row as Partial<Survey>
      return isPresent(r.seq) ? `第${r.seq}测次（${isPresent(r.date) ? r.date : MISSING_TOKEN}）` : '未编号测次'
    }
    case 'advice': {
      const r = row as Partial<Advice>
      return `${isPresent(r.level) ? r.level : MISSING_TOKEN}整治建议`
    }
  }
}

/** 生成一条内容摘要：按固定字段顺序拼接「字段名:值」 */
export function summarizeRow(entityType: RevisionEntityType, row: Partial<BusinessRow> | null): string {
  if (!row) return ''
  const labels = FIELD_LABELS[entityType]
  const parts = AUDIT_FIELDS[entityType].map((field) => {
    const raw = (row as Record<string, unknown>)[field]
    return `${labels[field]}:${formatAuditValue(field, raw)}`
  })
  return parts.join('；')
}

/**
 * 比对两个业务行（可能为旧格式缺字段），仅输出纳入审计的字段差异。
 * @param before 变更前行；null 表示新建
 */
export function diffRows(
  entityType: RevisionEntityType,
  before: Partial<BusinessRow> | null,
  after: Partial<BusinessRow>
): RevisionFieldChange[] {
  const labels = FIELD_LABELS[entityType]
  return AUDIT_FIELDS[entityType].flatMap((field) => {
    const beforeValue = before ? (before as Record<string, unknown>)[field] : undefined
    const afterValue = (after as Record<string, unknown>)[field]
    const beforeText = isPresent(beforeValue) ? formatAuditValue(field, beforeValue) : null
    const afterText = isPresent(afterValue) ? formatAuditValue(field, afterValue) : null
    if (beforeText === afterText) return []
    return [{ field, fieldLabel: labels[field], before: beforeText, after: afterText }]
  })
}

/** 摘要不相等的字段名（首条摘要对账用，按字段逐个核对） */
export function mismatchedFields(
  entityType: RevisionEntityType,
  summary: string,
  row: Partial<BusinessRow>
): string[] {
  const expected = summarizeRow(entityType, row)
  if (summary === expected) return []
  const parse = (text: string): Record<string, string> => {
    const map: Record<string, string> = {}
    text.split('；').forEach((segment) => {
      const index = segment.indexOf(':')
      if (index > 0) map[segment.slice(0, index)] = segment.slice(index + 1)
    })
    return map
  }
  const left = parse(summary)
  const right = parse(expected)
  return AUDIT_FIELDS[entityType].filter((field) => {
    const label = FIELD_LABELS[entityType][field]
    return (left[label] ?? MISSING_TOKEN) !== (right[label] ?? MISSING_TOKEN)
  })
}
