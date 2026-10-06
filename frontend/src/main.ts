import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from '@/App.vue'
import router from '@/router'
import { initDatabase, stampDbVersion } from '@/utils/db'
import '@/styles/main.css'

const app = createApp(App)

Object.entries(ElementPlusIconsVue).forEach(([key, component]) => {
  app.component(key, component)
})

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })

stampDbVersion()

// 首屏先完成 IndexedDB 打开与演示数据播种，再挂载应用，避免列表页空窗
void initDatabase()
  .catch((error: unknown) => {
    console.error('本地数据库初始化失败', error)
  })
  .finally(() => {
    app.mount('#app')
  })
