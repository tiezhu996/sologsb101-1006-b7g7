/**
 * 路由表：/sections、/cracks、/surveys、/trends、/backup
 * 页面按路由懒加载，构建时自动分包。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/sections' },
  {
    path: '/sections',
    name: 'section-list',
    component: () => import('@/pages/SectionList.vue'),
    meta: { title: '区间与环片里程台账', icon: 'Files' }
  },
  {
    path: '/cracks',
    name: 'crack-entry',
    component: () => import('@/pages/CrackEntry.vue'),
    meta: { title: '裂缝初测录入', icon: 'Grid' }
  },
  {
    path: '/surveys',
    name: 'survey-compare',
    component: () => import('@/pages/SurveyCompare.vue'),
    meta: { title: '复测测次与变化量对比', icon: 'DataLine' }
  },
  {
    path: '/trends',
    name: 'trend-board',
    component: () => import('@/pages/TrendBoard.vue'),
    meta: { title: '发展速率分级与预警', icon: 'TrendCharts' }
  },
  {
    path: '/backup',
    name: 'backup-view',
    component: () => import('@/pages/BackupView.vue'),
    meta: { title: '整治建议与数据备份', icon: 'Coin' }
  },
  {
    path: '/audit',
    name: 'audit-view',
    component: () => import('@/pages/AuditView.vue'),
    meta: { title: '修订链核对（审计抽查）', icon: 'DocumentChecked' }
  },
  { path: '/:pathMatch(.*)*', redirect: '/sections' }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '地铁隧道环片裂缝复测台账'
  document.title = `${title} · 地铁隧道环片裂缝复测台账`
})

export default router
