/**
 * 旧数据升级验证：先按 v2 结构建库写数据（无 revisions 表），
 * 再用当前 db 模块打开触发 version(3).upgrade，验证按当时内容补初始链。
 */
import assert from 'node:assert/strict'
import fakeIndexedDBMod from 'fake-indexeddb'
import { IDBKeyRange as FakeKeyRange } from 'fake-indexeddb'

const fidb = (fakeIndexedDBMod as unknown as { default?: IDBFactory }).default ?? (fakeIndexedDBMod as unknown as IDBFactory)
globalThis.indexedDB = fidb
globalThis.IDBKeyRange = FakeKeyRange as unknown as typeof IDBKeyRange

const Dexie = (await import('dexie')).default

let passed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  assert.ok(cond, `❌ ${name}${extra ? ` ${JSON.stringify(extra)}` : ''}`)
  console.log(`  ✓ ${name}`)
  passed += 1
}

const DB_NAME = 'gbtunnelcrack'

// 1) 用一个仅声明 v1/v2 的 Dexie 实例建旧库
class OldDb extends Dexie {
  sections!: Dexie.Table<Record<string, unknown>, string>
  rings!: Dexie.Table<Record<string, unknown>, string>
  cracks!: Dexie.Table<Record<string, unknown>, string>
  surveys!: Dexie.Table<Record<string, unknown>, string>
  advices!: Dexie.Table<Record<string, unknown>, string>

  constructor() {
    super(DB_NAME)
    this.version(1).stores({
      sections: 'id, line, structureType, startMileage',
      rings: 'id, sectionId, ringNo, mileage',
      cracks: 'id, ringId, code, position, direction, state',
      surveys: 'id, crackId, seq, date',
      advices: 'id, crackId, level, measure, state'
    })
    this.version(2)
      .stores({
        sections: 'id, line, structureType, startMileage, updatedAt',
        rings: 'id, sectionId, ringNo, mileage, segmentType, updatedAt',
        cracks: 'id, ringId, sectionId, code, position, direction, state, updatedAt',
        surveys: 'id, crackId, seq, date, surveyor, updatedAt',
        advices: 'id, crackId, level, measure, state, updatedAt'
      })
  }
}

console.log('① 构造 v2 旧库（无修订链、有一条缺字段裂缝）')
const oldDb = new OldDb()
const now = Date.now()
await oldDb.sections.bulkPut([
  { id: 'sec-a', line: '5号线', startMileage: 1000, endMileage: 2000, structureType: '盾构', ringCount: 10, createdAt: now, updatedAt: now }
])
await oldDb.rings.bulkPut([
  { id: 'ring-a', sectionId: 'sec-a', ringNo: 1, mileage: 1000, segmentType: '钢筋混凝土', installDate: '2020-01-01', createdAt: now, updatedAt: now }
])
await oldDb.cracks.bulkPut([
  // 正常旧裂缝
  { id: 'crack-a', ringId: 'ring-a', sectionId: 'sec-a', code: 'OLD-01', position: '拱顶', direction: '纵向', widthMm: 0.2, lengthMm: 300, state: '观察', createdAt: now, updatedAt: now },
  // 缺字段旧裂缝（lengthMm 缺失、state 缺失）
  { id: 'crack-b', ringId: 'ring-a', sectionId: 'sec-a', code: 'OLD-02', position: '侧墙', direction: '环向', widthMm: 0.1, createdAt: now, updatedAt: now }
])
await oldDb.surveys.bulkPut([
  { id: 'sv-a', crackId: 'crack-a', seq: 1, date: '2024-01-01', widthMm: 0.2, lengthMm: 300, deltaWidthMm: 0, surveyor: '张三', createdAt: now, updatedAt: now }
])
await oldDb.advices.bulkPut([
  { id: 'ad-a', crackId: 'crack-a', level: '一般', measure: '观测', basis: '旧依据', state: '待下发', createdAt: now, updatedAt: now }
])
await oldDb.close()

console.log('② 用当前应用代码打开旧库（触发 v3 upgrade）')
const { db } = await import('../src/utils/db.ts')
await db.open()

{
  const revisions = await db.revisions.toArray()
  const entities = 1 + 1 + 2 + 1 + 1
  check(`v3 升级后为全部 ${entities} 个旧对象补初始链`, revisions.length === entities, revisions.length)
  const crackB = revisions.filter((r) => r.entityId === 'crack-b')
  check('缺字段裂缝也建了初始链（1 条 initial）', crackB.length === 1 && crackB[0].kind === 'initial')
  check('初始摘要按当时内容生成并标注缺失',
    crackB[0].summary.includes('OLD-02')
    && crackB[0].summary.includes('缺失')
    && crackB[0].snapshot.lengthMm === null
    && crackB[0].snapshot.state === null,
    crackB[0].summary)
  check('来源标注为旧数据升级', crackB[0].source.includes('旧数据升级'))
  check('行 revision 推进到 3', (await db.cracks.get('crack-a'))?.revision === 3)
}

console.log('③ 升级后再打开（幂等，不重复补链）')
await db.close()
const mod = await import('../src/utils/db.ts')
await mod.db.open()
{
  const count = await mod.db.revisions.count()
  check('修订数仍为 6', count === 6, { count })
}

console.log('④ 升级后的旧裂缝做纠错：initial → correction，旧值可溯')
{
  await mod.db.open()
  const { updateEntity, revisionsOf } = await import('../src/utils/ledgerGateway.ts')
  await updateEntity('crack', 'crack-a', { widthMm: 0.45 }, { source: '升级后现场纠错', action: '宽度更正' })
  const chain = await revisionsOf('crack', 'crack-a')
  check('链为 initial + correction', chain.length === 2 && chain[0].kind === 'initial' && chain[1].kind === 'correction')
  check('correction 前一条摘要指向升级时的初始摘要', chain[1].prevSummary === chain[0].summary)
  check('旧值 0.2 保留在初始快照', chain[0].snapshot.widthMm === 0.2)
  check('变化 0.2 → 0.45', chain[1].changedSummary?.includes('0.20 → 0.45'))
}

console.log(`\n升级验证全部 ${passed} 项通过 ✅`)
process.exit(0)
