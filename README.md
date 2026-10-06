# 地铁隧道环片裂缝复测台账（sologsb101-1006）

面向地铁运营隧道结构维保班组与第三方监测单位，把区间内每环管片的裂缝逐条建档，并按测次复测比对裂缝发展情况。核心动作：录入区间与环片里程、登记裂缝部位与走向、按测次复测宽度长度、算发展速率、给出整治建议。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22806**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5 | `<script setup>` + Composition API |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `vue-tsc --noEmit` |
| UI 组件 | Element Plus 2.9 | 表格、表单、弹窗、抽屉、标签、进度 |
| 状态管理 | Pinia 2.3 | `sectionStore` / `crackStore` / `surveyStore` |
| 路由 | Vue Router 4.5 | History 模式，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1006/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbtunnelcrack
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # section.ts ring.ts crack.ts survey.ts advice.ts revision.ts
        ├── stores/             # sectionStore.ts crackStore.ts surveyStore.ts revisionStore.ts
        ├── components/common/  # LevelTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useCrackTrend.ts useIdbTable.ts
        ├── pages/              # SectionList.vue CrackEntry.vue SurveyCompare.vue TrendBoard.vue AuditView.vue BackupView.vue
        ├── router/index.ts
        ├── utils/              # rate.ts db.ts export.ts ledgerGateway.ts ledgerSummary.ts audit.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
    scripts/                     # verify-revision.mts verify-upgrade.mts（Node 修订链验证脚本）
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/sections` | 区间与环片里程台账 | Section、Ring | 新建/编辑/删除区间与环片；按线路、结构型式筛选；里程区间二维筛选；展开环片查看裂缝 |
| `/cracks` | 裂缝初测录入 | Crack、Ring | 新增/编辑/删除裂缝；勾选批量改状态；单条状态流转（观察→待整治→已整治）；导出 CSV |
| `/surveys` | 复测测次与变化量对比 | Survey、Crack | 按测次追加读数（自动比对生成变化量）；SVG 折线对比历次宽度；编辑/删除测次 |
| `/trends` | 发展速率分级与预警 | Crack、Survey、Advice | 按月均速率降序排行；仅看预警开关；一键生成整治建议草稿；抽屉查看测次序列 |
| `/audit` | 修订链核对（审计抽查） | 全部模型 + Revision | 扫描全库核对第一条摘要/链条/台账当前值；指出内容缺失、链条断开、旧记录未建链及关联对象；按当时内容补初始链 |
| `/backup` | 整治建议与数据备份 | 全部模型 | 建议状态流转（待下发→已下发→已完成）；导出/导入全量 JSON；导出 CSV；清空/重置演示数据 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbtunnelcrack`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`sections`、`rings`、`cracks`、`surveys`、`advices` + 只追加的修订链表 `revisions`
- **数据结构版本**：`DB_VERSION = 3`
  - `version(1)` → `version(2)`：补齐行修订号 `revision`、用所属环片回填历史裂缝的 `sectionId` 冗余列、补齐缺失的变化量字段
  - `version(3)`：新增 `revisions` 表；升级事务按旧行**当时内容**补初始链（缺失字段照实标注「缺失」，不算篡改），补链任一步失败整体回滚到写入前状态，下次打开库时幂等重试、重复不多记
- **修订链（审计留痕）机制**（`src/utils/ledgerGateway.ts`、`src/utils/audit.ts`）：
  - 现场台账保存当前值；区间/环片/裂缝/复测测次/整治建议每次写入都在 `revisions` 追加一条记录：`source` 来源、`prevId/prevSummary` 前一条、`summary` 当前摘要、`snapshot` 当时字段快照
  - 新增记 `initial`（初始记录）；现场纠错**不盖旧值**，只在链尾追加 `correction`（更正记录，含「旧值 → 新值」变化文案）；跟踪字段无变化不追加
  - 核对页 `/audit` 全库扫描，问题分三类：**内容缺失**（旧记录缺字段，非篡改）、**链条断开**（序号断档 / prevId、前一条摘要对不上 / 末次摘要与台账当前值不一致，疑似直接盖写）、**旧记录未建链**（可一键或逐条按当时内容补初始链）；每条问题给出关联对象（裂缝→环片→区间）
  - 级联删除随行清除修订链；修订链随全量 JSON 备份导出/导入，旧档无链时导入即补
- **首屏自动播种**：`initDatabase()` 中 `if (await db.sections.count() === 0) await seedDatabase()`，播种 2 个区间 → 5 个环片 → 6 条裂缝 → 14 个测次 → 4 条建议的互相引用演示数据并同步建初始链；播种与启动兜底补链均为幂等操作，重复调用不会重复插入/重复建链
- **验证脚本**（Node + fake-indexeddb，不依赖浏览器）：`npm run verify:revision`（建链/纠错/审计/回滚重试/幂等 38 项）、`npm run verify:upgrade`（v2→v3 旧数据补链 10 项）
- **localStorage 辅助键**：`gbtunnelcrack:db-version`（结构版本号）、`gbtunnelcrack:last-backup-at`（最近备份时间）、`gbtunnelcrack:ui-prefs`（上次选中区间、仅看预警开关）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷；清理浏览器数据即清空业务数据（可在 `/backup` 页重新播种）

## 六、本地开发

```bash
cd frontend
npm install
npm run dev              # http://localhost:22806
npm run build            # vue-tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview          # 本地预览构建产物
npm run verify:revision  # 修订链/审计/回滚重试/幂等验证（Node + fake-indexeddb）
npm run verify:upgrade   # v2 旧库 → v3 升级补初始链验证
```

> 提示：开发时浏览器直接使用本机 IndexedDB；若与 Docker 版本混用同一浏览器，数据是同一份（同源端口不同则为不同源，数据互相独立）。

## 七、判定口径

- 月均速率 `mm/月 = (本次宽度 − 上次宽度) ÷ 间隔天数 × 30`
- 分级阈值：`< 0.10` 一般，`0.10 ~ 0.25` 较重，`≥ 0.25` 严重
- 预警数 = 速率分级为「较重」及以上的裂缝数量
