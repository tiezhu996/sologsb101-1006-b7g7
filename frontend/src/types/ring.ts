/** 环片：区间内一环管片，裂缝的最小归属单元 */
export type SegmentType = '钢筋混凝土' | '铸铁' | '钢管片'

export interface Ring {
  id: string
  sectionId: string
  /** 环号 */
  ringNo: number
  /** 里程（m） */
  mileage: number
  segmentType: SegmentType
  /** 安装日期 YYYY-MM-DD */
  installDate: string
  createdAt: number
  updatedAt: number
}

export const SEGMENT_TYPES: SegmentType[] = ['钢筋混凝土', '铸铁', '钢管片']

export interface RingDraft {
  sectionId: string
  ringNo: number
  mileage: number
  segmentType: SegmentType
  installDate: string
}

export const EMPTY_RING_DRAFT: RingDraft = {
  sectionId: '',
  ringNo: 0,
  mileage: 0,
  segmentType: '钢筋混凝土',
  installDate: ''
}

/** 里程区间筛选条件（环片二维筛选的第二维） */
export interface MileageRange {
  from: number | null
  to: number | null
}

export function inMileageRange(mileage: number, range: MileageRange): boolean {
  if (range.from !== null && mileage < range.from) return false
  if (range.to !== null && mileage > range.to) return false
  return true
}
