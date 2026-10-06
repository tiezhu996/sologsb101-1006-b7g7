<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Coin, DataLine, DocumentChecked, Files, Grid, TrendCharts } from '@element-plus/icons-vue'
import { useSectionStore } from '@/stores/sectionStore'
import { useCrackStore } from '@/stores/crackStore'
import { useSurveyStore } from '@/stores/surveyStore'

const route = useRoute()
const router = useRouter()
const sectionStore = useSectionStore()
const crackStore = useCrackStore()
const surveyStore = useSurveyStore()

const navItems = computed(() => [
  { path: '/sections', label: '区间台账', icon: Files, badge: String(sectionStore.sections.length) },
  { path: '/cracks', label: '裂缝初测', icon: Grid, badge: String(crackStore.cracks.length) },
  { path: '/surveys', label: '复测对比', icon: DataLine, badge: String(surveyStore.surveys.length) },
  { path: '/trends', label: '速率分级', icon: TrendCharts, badge: String(crackStore.warningCount) },
  { path: '/backup', label: '建议与备份', icon: Coin, badge: '' },
  { path: '/audit', label: '修订链核对', icon: DocumentChecked, badge: '' }
])

const activePath = computed(() => {
  if (route.path.startsWith('/sections')) return '/sections'
  if (route.path.startsWith('/audit')) return '/audit'
  return route.path
})

function go(path: string): void {
  void router.push(path)
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-header__brand">
        <span class="app-header__mark">隧</span>
        <div>
          <h1 class="app-header__title">地铁隧道环片裂缝复测台账</h1>
          <p class="app-header__sub">区间 · 环片 · 裂缝 · 复测测次 · 整治建议</p>
        </div>
      </div>
      <nav class="app-nav">
        <button
          v-for="item in navItems"
          :key="item.path"
          class="app-nav__item"
          :class="{ 'is-active': activePath === item.path }"
          type="button"
          @click="go(item.path)"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
          <em v-if="item.badge" class="app-nav__badge">{{ item.badge }}</em>
        </button>
      </nav>
    </header>

    <main class="app-main">
      <router-view />
    </main>

    <footer class="app-footer">
      <span>数据仅存于本浏览器（IndexedDB / localStorage），不上传任何服务器。</span>
      <span>
        当前区间：{{ sectionStore.currentSection ? sectionStore.currentSection.line : '未选择' }} ·
        预警裂缝 {{ crackStore.warningCount }} 条 / 共 {{ crackStore.cracks.length }} 条
      </span>
    </footer>
  </div>
</template>
