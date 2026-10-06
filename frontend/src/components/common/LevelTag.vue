<script setup lang="ts">
/**
 * <LevelTag> 按 一般 / 较重 / 严重 渲染底色与图标
 * 被裂缝初测录入、发展速率分级、整治建议三页消费。
 */
import { computed, type Component } from 'vue'
import { CircleCloseFilled, SuccessFilled, WarningFilled } from '@element-plus/icons-vue'
import type { AdviceLevel } from '@/types/advice'
import { formatRate, LEVEL_BG, LEVEL_COLOR } from '@/utils/rate'

const props = withDefaults(
  defineProps<{
    level: AdviceLevel
    /** 附加展示的月均速率（mm/月） */
    rate?: number
    size?: 'small' | 'default' | 'large'
    /** 描边风格 */
    plain?: boolean
    icon?: boolean
  }>(),
  {
    rate: undefined,
    size: 'default',
    plain: false,
    icon: true
  }
)

const iconComponent = computed<Component>(() => {
  if (props.level === '严重') return CircleCloseFilled
  if (props.level === '较重') return WarningFilled
  return SuccessFilled
})

const style = computed(() => ({
  color: props.plain ? LEVEL_COLOR[props.level] : '#ffffff',
  backgroundColor: props.plain ? LEVEL_BG[props.level] : LEVEL_COLOR[props.level],
  borderColor: LEVEL_COLOR[props.level]
}))

const rateText = computed(() => (props.rate === undefined ? '' : formatRate(props.rate)))
</script>

<template>
  <span class="level-tag" :class="[`is-${size}`, { 'is-plain': plain }]" :style="style">
    <el-icon v-if="icon" class="level-tag__icon"><component :is="iconComponent" /></el-icon>
    <span class="level-tag__text">{{ level }}</span>
    <span v-if="rateText" class="level-tag__rate">· {{ rateText }}</span>
  </span>
</template>

<style scoped>
.level-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
}

.level-tag.is-small {
  padding: 0 8px;
  font-size: 12px;
  line-height: 18px;
}

.level-tag.is-large {
  padding: 4px 14px;
  font-size: 15px;
  line-height: 24px;
}

.level-tag__icon {
  font-size: 13px;
}

.level-tag__rate {
  font-weight: 400;
  opacity: 0.9;
}
</style>
