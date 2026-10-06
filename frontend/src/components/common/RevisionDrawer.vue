<script setup lang="ts">
/**
 * 修订链抽屉：查看某个业务对象的完整留痕。
 * 每一条修订记录展示来源、动作、前一条摘要、当前摘要与字段差异；
 * 现场纠错只能看到追加的更正记录，旧值不会被覆盖。
 */
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  REVISION_ACTION_TEXT,
  REVISION_ENTITY_TEXT,
  type Revision,
  type RevisionEntityType
} from '@/types/revision'
import { listRevisions } from '@/utils/revisionService'

const props = defineProps<{
  modelValue: boolean
  entityType: RevisionEntityType
  entityId: string
  /** 对象名（裂缝编号 / 环号等），无修订记录时兜底展示 */
  entityLabel?: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const loading = ref(false)
const revisions = ref<Revision[]>([])

function close(): void {
  emit('update:modelValue', false)
}

async function load(): Promise<void> {
  if (!props.entityId) return
  loading.value = true
  try {
    revisions.value = await listRevisions(props.entityType, props.entityId)
  } catch (error) {
    ElMessage.error(`读取修订链失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.modelValue, props.entityId] as const,
  ([visible]) => {
    if (visible) void load()
  },
  { immediate: true }
)

defineExpose({ reload: load })

function timeText(ts: number): string {
  const date = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const actionTagType = (action: Revision['action']): 'primary' | 'warning' | 'info' => {
  if (action === 'correct') return 'warning'
  if (action === 'backfill') return 'info'
  return 'primary'
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    :title="`修订链 · ${REVISION_ENTITY_TEXT[entityType]} ${entityLabel ?? ''}`"
    size="560px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-loading="loading">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="修订链与现场台账分开保存：建档落链首，现场纠错只追加更正记录，不覆盖任何历史值。"
        style="margin-bottom: 14px"
      />

      <el-empty v-if="!loading && revisions.length === 0" description="该对象还没有任何修订记录（旧记录未建链）" />

      <el-timeline v-else>
        <el-timeline-item
          v-for="revision in [...revisions].sort((a, b) => b.seq - a.seq)"
          :key="revision.id"
          :timestamp="timeText(revision.createdAt)"
          placement="top"
          :type="revision.tombstone ? 'danger' : revision.action === 'correct' ? 'warning' : 'primary'"
        >
          <el-card shadow="never" style="margin-bottom: 6px">
            <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px">
              <el-tag size="small" :type="actionTagType(revision.action)">
                第 {{ revision.seq }} 条 · {{ REVISION_ACTION_TEXT[revision.action] }}
              </el-tag>
              <el-tag size="small" effect="plain" type="info">来源：{{ revision.source }}</el-tag>
              <el-tag v-if="revision.tombstone" size="small" type="danger">已删除（墓碑）</el-tag>
              <span class="muted" style="margin-left: auto">记录人：{{ revision.operator }}</span>
            </div>

            <div v-if="revision.relatedLabel" class="muted" style="margin-bottom: 6px">关联对象：{{ revision.relatedLabel }}</div>

            <div v-if="revision.changes.length > 0" class="rev-changes">
              <div v-for="change in revision.changes" :key="change.field" class="rev-change">
                <span class="rev-change__label">{{ change.fieldLabel }}</span>
                <span class="rev-change__before">{{ change.before ?? '—' }}</span>
                <el-icon><Right /></el-icon>
                <span class="rev-change__after">{{ change.after ?? '—' }}</span>
              </div>
            </div>

            <el-divider style="margin: 8px 0" />

            <dl class="rev-summary">
              <dt>前一条摘要</dt>
              <dd>{{ revision.prevSummary ?? '（链首，无前一条）' }}</dd>
              <dt>当前摘要</dt>
              <dd :class="{ 'rev-tombstone-text': revision.tombstone }">{{ revision.summary }}</dd>
            </dl>
          </el-card>
        </el-timeline-item>
      </el-timeline>

      <div v-if="revisions.length > 0" class="muted" style="text-align: center; padding: 8px 0">
        共 {{ revisions.length }} 条修订记录 · 审计抽查可凭此链还原每次写入
      </div>
    </div>

    <template #footer>
      <el-button @click="close">关闭</el-button>
      <el-button type="primary" :loading="loading" @click="load">刷新</el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.muted {
  color: #8c99ab;
  font-size: 12px;
}

.rev-change {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 4px;
}

.rev-change__label {
  min-width: 84px;
  color: #5b6b82;
}

.rev-change__before {
  color: #97a3b5;
  text-decoration: line-through;
}

.rev-change__after {
  color: #c0392b;
  font-weight: 600;
}

.rev-summary {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
}

.rev-summary dt {
  color: #8c99ab;
}

.rev-summary dd {
  margin: 0 0 6px;
  color: #16233a;
  word-break: break-all;
}

.rev-tombstone-text {
  color: #c0392b;
}
</style>
