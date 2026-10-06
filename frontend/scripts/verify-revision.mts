/**
 * 修订链端到端验证（Node + fake-indexeddb），不入产品包：
 * 1) 首装播种即建初始链；2) 纠错只追加；3) 审计三类判定与关联对象；
 * 4) 未建链补链幂等；5) 无变化不多记；6) 失败回滚重试。
 */
import assert from 'node:assert/strict'
import fakeIndexedDBMod from 'fake-indexeddb'
import { IDBKeyRange as FakeKeyRange } from 'fake-indexeddb'

const fidb = (fakeIndexedDBMod as unknown as { default?: IDBFactory }).default ?? (fakeIndexedDBMod as unknown as IDBFactory)
globalThis.indexedDB = fidb
globalThis.IDBKeyRange = FakeKeyRange as unknown as typeof IDBKeyRange

const [{ db, seedDatabase, initDatabase }, gateway, auditMod] = await Promise.all([
  import('../src/utils/db.ts'),
  import('../src/utils/ledgerGateway.ts'),
  import('../src/utils/audit.ts')
])
const { backfillMissingChains, updateEntity, revisionsOf, deleteEntitiesWithChain } = gateway as typeof import('../src/utils/ledgerGateway.ts')
const { buildAuditReport } = auditMod as typeof import('../src/utils/audit.ts')
void deleteEntitiesWithChain

let passed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  assert.ok(cond, `❌ ${name}${extra ? ` ${JSON.stringify(extra)}` : ''}`)
  console.log(`  ✓ ${name}`)
  passed += 1
}

async function dataset() {
  const [sections, rings, cracks, surveys, advices, revisions] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray(),
    db.advices.toArray(),
    db.revisions.toArray()
  ])
  return { sections, rings, cracks, surveys, advices, revisions }
}

console.log('① 全新打开库 + 首屏播种')
await initDatabase()
{
  const data = await dataset()
  const entities =
    data.sections.length + data.rings.length + data.cracks.length + data.surveys.length + data.advices.length
  check('五个业务表均有种子数据', entities === 2 + 5 + 6 + 14 + 4, {
    counts: [data.sections.length, data.rings.length, data.cracks.length, data.surveys.length, data.advices.length]
  })
  check('每个业务对象恰好 1 条初始修订', data.revisions.length === entities, {
    revisions: data.revisions.length,
    entities
  })
  const crack1Revs = data.revisions.filter((r) => r.entityType === 'crack' && r.entityId === 'crack-1')
  check('裂缝 crack-1 首条为 initial、prevId/prevSummary 为空', crack1Revs.length === 1
    && crack1Revs[0].kind === 'initial'
    && crack1Revs[0].prevId === null
    && crack1Revs[0].prevSummary === null)
  check('初始修订带来源', crack1Revs[0].source.includes('播种'))
  check('初始修订当前摘要含关键字段', crack1Revs[0].summary.includes('SL-118-01') && crack1Revs[0].summary.includes('0.42'))
}

console.log('② 重复播种 / 重复启动兜底补链不多记')
await seedDatabase()
await backfillMissingChains({ source: '重复操作' })
{
  const revisions = await db.revisions.count()
  const entities = 31
  check('修订总数仍等于对象数（幂等）', revisions === entities, { revisions })
}

console.log('③ 现场纠错：只追加更正记录，旧值保留')
{
  const before = await db.cracks.get('crack-2')!
  const { updateEntity } = await import('../src/utils/ledgerGateway.ts')
  const res = await updateEntity('crack', 'crack-2', { widthMm: 0.33 }, { source: '审计抽查现场纠错', action: '宽度更正' })
  check('网关报告有字段变化', res.changed === true && res.keys.includes('widthMm'))
  const after = await db.cracks.get('crack-2')!
  check('台账当前值已更新为新值', after.widthMm === 0.33, { width: after.widthMm })

  const { revisionsOf } = await import('../src/utils/ledgerGateway.ts')
  const chain = await revisionsOf('crack', 'crack-2')
  check('链长度变为 2（initial + correction）', chain.length === 2, { len: chain.length })
  check('第 2 条是 correction 且 seq=2', chain[1].kind === 'correction' && chain[1].seq === 2)
  check('第 2 条记录来源', chain[1].source === '审计抽查现场纠错')
  check('第 2 条 prevId 指向第 1 条', chain[1].prevId === chain[0].id)
  check('第 2 条 prevSummary 等于第 1 条 summary', chain[1].prevSummary === chain[0].summary)
  check('第 1 条快照仍保留旧值 0.18（旧值未被盖掉）', chain[0].snapshot.widthMm === before!.widthMm)
  check('变化文案记录 旧值 → 新值', chain[1].changedSummary?.includes('0.18 → 0.33') === true, chain[1].changedSummary)
  check('第 2 条当前摘要为新值', chain[1].summary.includes('0.33'))
}

console.log('④ 无变化的写入不追加修订（重复操作不多记）')
{
  const countBefore = await db.revisions.where('[entityType+entityId]').equals(['crack', 'crack-2']).count()
  const { updateEntity } = await import('../src/utils/ledgerGateway.ts')
  const res = await updateEntity('crack', 'crack-2', { widthMm: 0.33 }, { source: '重复纠错' })
  const countAfter = await db.revisions.where('[entityType+entityId]').equals(['crack', 'crack-2']).count()
  check('网关报告无变化', res.changed === false)
  check('修订条数不增加', countBefore === countAfter, { countBefore, countAfter })
}

console.log('⑤ 核对页：干净库扫描应为 0 问题')
{
  const report = buildAuditReport(await dataset())
  check('无任何核对问题', report.issueCount === 0, { issues: report.issues.map((i) => i.message) })
}

console.log('⑥ 构造三类问题并核对')
// 6a) 旧记录未建链：删掉 crack-3 的链
await db.revisions.where('[entityType+entityId]').equals(['crack', 'crack-3']).delete()
// 6b) 链条断开：篡改 crack-4 末次修订的 summary（模拟就地盖写）
{
  const chain = (await db.revisions.where('[entityType+entityId]').equals(['crack', 'crack-4']).toArray())
  await db.revisions.update(chain[0].id, { summary: '被人手工改过的摘要' })
}
// 6c) 内容缺失：插入一条缺字段、无链的旧 section，再补初始链
{
  const at = Date.now()
  await db.sections.add({
    id: 'sec-old',
    line: '',
    startMileage: 9000,
    endMileage: 9100,
    structureType: '盾构',
    ringCount: 3,
    createdAt: at,
    updatedAt: at,
    revision: 3
  } as never)
}
{
  const report = buildAuditReport(await dataset())
  const find = (type: string, id: string, kind: string) =>
    report.issues.find((i) => i.entityType === type && i.entityId === id && i.issueKind === kind)

  const unchained = find('crack', 'crack-3', 'unchained')
  check('指出 crack-3 旧记录未建链', Boolean(unchained))
  check('未建链问题可修复', unchained?.repairable === true)
  check('关联对象指向 ring-2 / sec-1',
    unchained?.related.some((r) => r.entityId === 'ring-2') === true
    && unchained.related.some((r) => r.entityId === 'sec-1') === true,
    unchained?.related.map((r) => r.entityId))

  const broken = find('crack', 'crack-4', 'broken')
  check('指出 crack-4 链条断开（摘要与快照对不上）', Boolean(broken), broken?.message)

  const missingUnchained = find('section', 'sec-old', 'unchained')
  check('缺字段旧 section 先报未建链', Boolean(missingUnchained))
  check('报告三类计数正确',
    report.issueCounts.unchained >= 2 && report.issueCounts.broken >= 1,
    report.issueCounts)
}

console.log('⑦ 对未建链对象按当时内容补初始链（缺失不算篡改）')
{
  const result = await backfillMissingChains({ source: '审计核对补链' })
  check('补建 2 条链（crack-3、sec-old）', result.created === 2, result)
  const report = buildAuditReport(await dataset())
  const secOldIssue = report.issues.find((i) => i.entityId === 'sec-old')
  check('sec-old 补链后报「内容缺失」而非篡改', secOldIssue?.issueKind === 'missing', secOldIssue)
  check('内容缺失说明列出缺失字段', secOldIssue?.message.includes('line') === true, secOldIssue?.message)
  const crack3 = report.issues.find((i) => i.entityId === 'crack-3')
  check('crack-3 补链后无问题', crack3 === undefined)
  const rev = (await db.revisions.where('[entityType+entityId]').equals(['section', 'sec-old']).toArray())[0]
  check('缺失字段初始摘要标注「缺失」', rev.summary.includes('缺失'), rev.summary)
}

console.log('⑧ 补链事务失败回滚 + 重试')
{
  // 再造一条未建链
  const at = Date.now()
  await db.sections.add({
    id: 'sec-x', line: '9号线', startMileage: 1, endMileage: 2,
    structureType: '矿山法', ringCount: 1, createdAt: at, updatedAt: at, revision: 3
  } as never)

  // 第一次尝试：patch db.transaction，在首个事务回调里让 revisions.bulkAdd 抛错（整事务回滚）
  const originalTransaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>
  let firstAttemptFailed = false
  let transactionCall = 0
  ;(db as unknown as { transaction: (...args: unknown[]) => Promise<unknown> }).transaction = (
    ...args: unknown[]
  ) => {
    transactionCall += 1
    const callback = args[args.length - 1] as (tx: {
      table: (name: string) => { bulkAdd: (rows: unknown[]) => Promise<unknown> }
    }) => Promise<unknown>
    if (transactionCall === 1) {
      args[args.length - 1] = (tx: { table: (name: string) => { bulkAdd: (rows: unknown[]) => Promise<unknown> } }) => {
        const revisionTable = tx.table('revisions')
        const originalBulkAdd = revisionTable.bulkAdd.bind(revisionTable)
        revisionTable.bulkAdd = async (rows: unknown[]) => {
          const hitsSecX = (rows as Array<{ entityId?: string }>).some((r) => r.entityId === 'sec-x')
          if (hitsSecX) {
            firstAttemptFailed = true
            throw new Error('注入故障：磁盘忙')
          }
          return originalBulkAdd(rows)
        }
        return callback(tx)
      }
    }
    return originalTransaction(...args)
  }

  const result = await backfillMissingChains({ source: '失败重试验证' })
  ;(db as unknown as { transaction: (...args: unknown[]) => Promise<unknown> }).transaction = originalTransaction
  check('第一次尝试确实失败并回滚', firstAttemptFailed)
  check('回滚后重试成功，仅补 1 条', result.created === 1, result)
  const count = await db.revisions.where('[entityType+entityId]').equals(['section', 'sec-x']).count()
  check('sec-x 最终恰好 1 条修订（回滚没留下半成品）', count === 1, { count })

  // 再来一次：幂等
  const again = await backfillMissingChains({ source: '再点一次' })
  check('重复补链 created=0、全部跳过', again.created === 0 && again.skipped > 0, again)
  const count2 = await db.revisions.where('[entityType+entityId]').equals(['section', 'sec-x']).count()
  check('sec-x 仍恰好 1 条修订', count2 === 1)
}

console.log('⑨ 删除对象时修订链随行清除（无孤立修订）')
{
  const { deleteCrackCascade } = await import('../src/utils/db.ts')
  await deleteCrackCascade('crack-6')
  const leftover = await db.revisions.where('[entityType+entityId]').equals(['crack', 'crack-6']).count()
  const surveyLeftover = await db.revisions.where('entityType').equals('survey').filter((r) => r.entityId.startsWith('sv-6')).count()
  check('裂缝修订链已清除', leftover === 0)
  check('级联的测次修订链已清除', surveyLeftover === 0)
  const report = buildAuditReport(await dataset())
  check('无孤立修订问题', report.issues.every((i) => !i.key.startsWith('orphan|')))
}

console.log(`\n全部 ${passed} 项验证通过 ✅`)
await db.close()
process.exit(0)
