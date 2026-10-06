<script setup lang="ts">
/**
 * <FilterBar> 线路 / 部位 / 走向等多条件过滤，并把条件同步到 URL query。
 * 被裂缝初测录入、复测对比、速率分级三页消费。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { Refresh, Search } from '@element-plus/icons-vue'

export interface FilterSelectOption {
  label: string
  value: string
}

export interface FilterSelectConfig {
  /** query key，同时作为组件内唯一标识 */
  key: string
  label: string
  options: FilterSelectOption[]
  placeholder?: string
  /** 多选（默认）或单选 */
  multiple?: boolean
}

export interface FilterModel {
  keyword: string
  [key: string]: string | string[] | boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: FilterModel
    selects?: FilterSelectConfig[]
    keywordPlaceholder?: string
    /** 是否把条件同步到 URL query */
    syncQuery?: boolean
    showReset?: boolean
  }>(),
  {
    selects: () => [],
    keywordPlaceholder: '搜索编号或里程…',
    syncQuery: true,
    showReset: true
  }
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: FilterModel): void
  (event: 'change', value: FilterModel): void
  (event: 'reset'): void
}>()

const route = useRoute()
const router = useRouter()
const keyword = ref(props.modelValue.keyword ?? '')

watch(
  () => props.modelValue,
  (value) => {
    keyword.value = value.keyword ?? ''
  },
  { deep: true }
)

const activeCount = computed(() => {
  const entries = Object.entries(props.modelValue).filter(([key]) => key !== 'keyword')
  return entries.reduce((sum, [, value]) => {
    if (Array.isArray(value)) return sum + value.length
    if (typeof value === 'string' && value.length > 0) return sum + 1
    if (typeof value === 'boolean' && value) return sum + 1
    return sum
  }, 0)
})

function queryKeyOf(key: string): string {
  return key === 'keyword' ? 'kw' : key
}

function readQuery(): FilterModel {
  const query = route.query
  const model: FilterModel = { keyword: typeof query.kw === 'string' ? query.kw : '' }
  props.selects.forEach((select) => {
    const raw = query[select.key]
    const values = typeof raw === 'string' ? raw.split(',').filter((item) => item.length > 0) : []
    model[select.key] = select.multiple === false ? values[0] ?? '' : values
  })
  return model
}

function pushQuery(model: FilterModel): void {
  if (!props.syncQuery) return
  const query: LocationQueryRaw = {}
  Object.entries(model).forEach(([key, value]) => {
    const target = queryKeyOf(key)
    if (Array.isArray(value)) {
      if (value.length > 0) query[target] = value.join(',')
    } else if (typeof value === 'string') {
      if (value.length > 0) query[target] = value
    }
  })
  void router.replace({ query })
}

function emitChange(next: FilterModel): void {
  emit('update:modelValue', next)
  emit('change', next)
  pushQuery(next)
}

function handleKeywordInput(value: string): void {
  keyword.value = value
  emitChange({ ...props.modelValue, keyword: value })
}

function handleSelect(key: string, value: string | string[]): void {
  emitChange({ ...props.modelValue, [key]: value })
}

function handleReset(): void {
  const cleared: FilterModel = { keyword: '' }
  props.selects.forEach((select) => {
    cleared[select.key] = select.multiple === false ? '' : []
  })
  keyword.value = ''
  emit('update:modelValue', cleared)
  if (props.syncQuery) void router.replace({ query: {} })
  emit('change', cleared)
  emit('reset')
}

function valueOf(key: string): string | string[] {
  const value = props.modelValue[key]
  if (Array.isArray(value)) return value
  return typeof value === 'string' ? value : ''
}

// 首次挂载：URL 上已有条件时回填给父级，保证筛选状态与地址栏一致
if (props.syncQuery && Object.keys(route.query).length > 0) {
  const restored = readQuery()
  keyword.value = restored.keyword
  emit('update:modelValue', restored)
  emit('change', restored)
}
</script>

<template>
  <div class="filter-bar">
    <div class="filter-bar__main">
      <el-input
        :model-value="keyword"
        class="filter-bar__keyword"
        :placeholder="keywordPlaceholder"
        clearable
        @update:model-value="handleKeywordInput"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>

      <div v-for="select in selects" :key="select.key" class="filter-bar__select">
        <span class="filter-bar__label">{{ select.label }}</span>
        <el-select
          :model-value="valueOf(select.key)"
          :multiple="select.multiple !== false"
          :collapse-tags="select.multiple !== false"
          collapse-tags-tooltip
          clearable
          :placeholder="select.placeholder ?? `选择${select.label}`"
          class="filter-bar__control"
          @update:model-value="(value: string | string[]) => handleSelect(select.key, value)"
        >
          <el-option v-for="option in select.options" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </div>

      <slot name="extra" />
    </div>

    <div class="filter-bar__side">
      <slot name="actions" />
      <el-tag v-if="activeCount > 0" type="warning" effect="plain" round>{{ activeCount }} 项条件</el-tag>
      <el-button v-if="showReset" :icon="Refresh" text type="primary" @click="handleReset">重置</el-button>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: #ffffff;
  border: 1px solid var(--tc-line);
  border-radius: 10px;
}

.filter-bar__main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  flex: 1 1 520px;
}

.filter-bar__side {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-bar__keyword {
  width: 220px;
}

.filter-bar__label {
  margin-right: 6px;
  font-size: 13px;
  color: var(--tc-ink-soft);
}

.filter-bar__select {
  display: flex;
  align-items: center;
}

.filter-bar__control {
  width: 178px;
}
</style>
