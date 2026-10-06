<script setup lang="ts">
/**
 * <StatBadge> 计数与占比徽标
 * 被区间台账、速率分级页消费。
 */
import { computed, type Component } from 'vue'
import {
  CircleCheckFilled,
  CircleCloseFilled,
  DataLine,
  Files,
  Grid,
  Histogram,
  TrendCharts,
  WarningFilled
} from '@element-plus/icons-vue'

type BadgeTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

const props = withDefaults(
  defineProps<{
    label: string
    value: number | string
    suffix?: string
    /** 占比 0-100，传入后渲染进度条并以百分比展示 */
    percent?: number
    tone?: BadgeTone
    icon?: string
    size?: 'default' | 'small'
  }>(),
  {
    suffix: '',
    percent: undefined,
    tone: 'default',
    icon: 'DataLine',
    size: 'default'
  }
)

const toneColor: Record<BadgeTone, string> = {
  default: '#5b6b82',
  primary: '#2b5c94',
  success: '#1e8449',
  warning: '#d68910',
  danger: '#c0392b',
  info: '#4a6fa5'
}

const iconMap: Record<string, Component> = {
  DataLine,
  Files,
  Grid,
  Histogram,
  TrendCharts,
  WarningFilled,
  CircleCloseFilled,
  CircleCheckFilled
}

const iconComponent = computed<Component>(() => iconMap[props.icon] ?? DataLine)
const color = computed(() => toneColor[props.tone])
const displayValue = computed(() =>
  props.percent !== undefined ? `${props.percent}%` : props.value
)
</script>

<template>
  <div class="stat-badge" :class="[`is-${size}`]" :style="{ '--badge-color': color }">
    <div class="stat-badge__head">
      <el-icon class="stat-badge__icon"><component :is="iconComponent" /></el-icon>
      <span class="stat-badge__label">{{ label }}</span>
    </div>
    <div class="stat-badge__body">
      <span class="stat-badge__value">{{ displayValue }}</span>
      <span v-if="suffix" class="stat-badge__suffix">{{ suffix }}</span>
    </div>
    <el-progress
      v-if="percent !== undefined"
      :percentage="Math.min(100, Math.max(0, percent))"
      :stroke-width="6"
      :show-text="false"
      :color="color"
    />
  </div>
</template>

<style scoped>
.stat-badge {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 136px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--tc-line);
  border-left: 4px solid var(--badge-color);
  border-radius: 10px;
}

.stat-badge.is-small {
  min-width: 108px;
  padding: 8px 10px;
}

.stat-badge__head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--tc-ink-soft);
  font-size: 13px;
}

.stat-badge__icon {
  color: var(--badge-color);
  font-size: 15px;
}

.stat-badge__body {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.stat-badge__value {
  font-size: 22px;
  font-weight: 700;
  color: var(--tc-ink);
  font-variant-numeric: tabular-nums;
}

.stat-badge.is-small .stat-badge__value {
  font-size: 18px;
}

.stat-badge__suffix {
  font-size: 12px;
  color: var(--tc-ink-soft);
}
</style>
