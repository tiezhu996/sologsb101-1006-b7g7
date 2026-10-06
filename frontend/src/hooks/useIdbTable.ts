import { liveQuery } from 'dexie'
import { onScopeDispose, ref, shallowRef, type Ref } from 'vue'
import { db, createId } from '@/utils/db'
import {
  insertEntity,
  updateEntity,
  type LedgerRow
} from '@/utils/ledgerGateway'
import type { RevisionEntityType, WriteContext } from '@/types/revision'

export type IdbRecord = { id: string; createdAt?: number; updatedAt?: number }

export interface UseIdbTableOptions<T extends IdbRecord> {
  /** 是否按 updatedAt 倒序，默认 true */
  sortByUpdatedAt?: boolean
  /** 是否在创建该 hook 时立即开始订阅，默认 true */
  immediate?: boolean
  /** 数据变化后的额外回调 */
  onChange?: (rows: T[]) => void
  /**
   * 绑定修订链实体类型后，create/update 自动走台账写入网关：
   * 新增记初始修订，纠错追加更正修订（含来源、前一条摘要、当前摘要）。
   * 不绑定（如 revisions 表本身）则按普通表读写。
   */
  entityType?: RevisionEntityType
  /** 默认写入来源；单次 create/update 可用 ctx 覆盖 */
  defaultSource?: string
  /** create 生成的主键前缀 */
  idPrefix?: string
}

export interface UseIdbTableResult<T extends IdbRecord> {
  rows: Ref<T[]>
  loading: Ref<boolean>
  /** 是否已完成首次载入：用于区分「数据为空」与「尚未读取」 */
  ready: Ref<boolean>
  error: Ref<string | null>
  refresh: () => Promise<void>
  stop: () => void
  getById: (id: string) => Promise<T | undefined>
  list: () => Promise<T[]>
  create: (payload: NewRecord<T>, idPrefixOrCtx?: string | WriteContext) => Promise<T>
  update: (id: string, patch: Partial<T>, ctx?: WriteContext) => Promise<unknown>
  upsert: (row: T) => Promise<void>
  remove: (id: string) => Promise<void>
  bulkRemove: (ids: string[]) => Promise<void>
  bulkPut: (list: T[]) => Promise<void>
  clear: () => Promise<void>
}

/** 新增记录入参：id / 时间戳由封装层补齐 */
export type NewRecord<T extends IdbRecord> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string
  createdAt?: number
  updatedAt?: number
}

/**
 * Dexie 单表增删改查 + liveQuery 响应式订阅封装。
 * 绑定 entityType 后，所有创建/纠错都经修订链网关落账，组件不直接写 Dexie。
 */
export function useIdbTable<T extends IdbRecord>(
  tableSelector: (database: typeof db) => import('dexie').Table<T, string>,
  options: UseIdbTableOptions<T> = {}
): UseIdbTableResult<T> {
  const {
    sortByUpdatedAt = true,
    immediate = true,
    onChange,
    entityType,
    defaultSource = '现场录入',
    idPrefix = 'row'
  } = options
  const table = tableSelector(db)

  const rows = ref([]) as Ref<T[]>
  const loading = ref(false)
  const ready = ref(false)
  const error = ref<string | null>(null)
  const subscription = shallowRef<{ unsubscribe: () => void } | null>(null)

  const applySort = (list: T[]): T[] => {
    if (!sortByUpdatedAt) return [...list]
    return [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  const refresh = async (): Promise<void> => {
    loading.value = true
    try {
      rows.value = applySort(await table.toArray())
      error.value = null
      ready.value = true
      onChange?.(rows.value)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '读取本地数据失败'
    } finally {
      loading.value = false
    }
  }

  const stop = (): void => {
    subscription.value?.unsubscribe()
    subscription.value = null
  }

  const create = async (payload: NewRecord<T>, idPrefixOrCtx?: string | WriteContext): Promise<T> => {
    // 未绑定修订链（revisions 表本身等）：保持普通写入
    if (!entityType) {
      const now = Date.now()
      const record = {
        ...(payload as object),
        id: payload.id ?? createId(typeof idPrefixOrCtx === 'string' ? idPrefixOrCtx : idPrefix),
        createdAt: payload.createdAt ?? now,
        updatedAt: payload.updatedAt ?? now
      } as T
      await table.put(record)
      return record
    }

    const ctx: WriteContext =
      typeof idPrefixOrCtx === 'object' && idPrefixOrCtx !== null
        ? idPrefixOrCtx
        : { source: defaultSource, action: '初始建账' }
    const inserted: LedgerRow = await insertEntity(entityType, payload as unknown as Record<string, unknown>, {
      idPrefix: typeof idPrefixOrCtx === 'string' ? idPrefixOrCtx : idPrefix,
      ...ctx
    })
    return inserted as T
  }

  const update = async (id: string, patch: Partial<T>, ctx?: WriteContext): Promise<unknown> => {
    if (!entityType) {
      await table.update(id, { ...patch, updatedAt: Date.now() } as never)
      return
    }
    return updateEntity(
      entityType,
      id,
      patch as unknown as Record<string, unknown>,
      ctx ?? { source: '现场纠错', action: '现场纠错' }
    )
  }

  const upsert = async (row: T): Promise<void> => {
    await table.put({ ...row, updatedAt: Date.now() } as T)
  }

  const remove = async (id: string): Promise<void> => {
    await table.delete(id)
  }

  const bulkRemove = async (ids: string[]): Promise<void> => {
    await table.bulkDelete(ids)
  }

  const bulkPut = async (list: T[]): Promise<void> => {
    await table.bulkPut(list)
  }

  const clear = async (): Promise<void> => {
    await table.clear()
  }

  if (immediate) {
    const observable = liveQuery(async () => applySort(await table.toArray()))
    subscription.value = observable.subscribe({
      next: (list) => {
        rows.value = list
        error.value = null
        ready.value = true
        onChange?.(list)
      },
      error: (err: unknown) => {
        error.value = err instanceof Error ? err.message : '订阅本地数据失败'
      }
    })
    void refresh()
  }

  onScopeDispose(stop)

  return {
    rows,
    loading,
    ready,
    error,
    refresh,
    stop,
    getById: (id: string) => table.get(id),
    list: () => table.toArray(),
    create,
    update,
    upsert,
    remove,
    bulkRemove,
    bulkPut,
    clear
  }
}

export type { LedgerRow }
