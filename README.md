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
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种；v3 起新增独立 `revisions` 修订链表 |
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
        ├── types/              # section.ts ring.ts crack.ts survey.ts advice.ts
        ├── stores/             # sectionStore.ts crackStore.ts surveyStore.ts
        ├── components/common/  # LevelTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useCrackTrend.ts useIdbTable.ts
        ├── pages/              # SectionList.vue CrackEntry.vue SurveyCompare.vue TrendBoard.vue BackupView.vue
        ├── router/index.ts
        ├── utils/              # rate.ts db.ts export.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/sections` | 区间与环片里程台账 | Section、Ring | 新建/编辑/删除区间与环片；按线路、结构型式筛选；里程区间二维筛选；展开环片查看裂缝 |
| `/cracks` | 裂缝初测录入 | Crack、Ring | 新增/编辑/删除裂缝；勾选批量改状态；单条状态流转（观察→待整治→已整治）；导出 CSV |
| `/surveys` | 复测测次与变化量对比 | Survey、Crack | 按测次追加读数（自动比对生成变化量）；SVG 折线对比历次宽度；编辑/删除测次 |
| `/trends` | 发展速率分级与预警 | Crack、Survey、Advice | 按月均速率降序排行；仅看预警开关；一键生成整治建议草稿；抽屉查看测次序列 |
| `/backup` | 整治建议与数据备份 | 全部模型 | 建议状态流转（待下发→已下发→已完成）；导出/导入全量 JSON；导出 CSV；清空/重置演示数据 |
| `/audit` | 修订链核对（审计抽查） | Revision + 全部模型 | 全库扫描第一条摘要与链条连续性；定位内容缺失/链条断开/旧记录未建链；按当时内容补初始链（失败恢复重试、重复不多记）；抽屉查看每条对象的完整修订链 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbtunnelcrack`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`sections`、`rings`、`cracks`、`surveys`、`advices` 五张现场台账表 + 独立的 `revisions` 修订链表（现场台账与修订链物理分离，互不覆盖）
- **数据结构版本**：`DB_VERSION = 3`
  - `version(1)` → `version(2)`：补齐行修订号 `revision`、用所属环片回填历史裂缝的 `sectionId` 冗余列、补齐缺失的变化量字段
  - `version(2)` → `version(3)`：新增 `revisions` 表（索引 `entityType`、`entityId`、`[entityType+entityId]`、`[entityType+seq]`）；升级事务内按每条记录**当时内容**补建初始链（链首），缺失字段以「缺失」入摘要，**不算篡改**；升级任一步失败整体回滚到写入前状态
- **修订链口径**（`src/types/revision.ts`、`src/utils/revisionSummary.ts`、`src/utils/revisionChain.ts`、`src/utils/revisionService.ts`）：
  - 区间 / 环片 / 裂缝 / 复测测次 / 整治建议每次写入都追加一条修订记录，含来源（现场建档 / 现场纠错 / 状态流转 / 复测最新读数同步 / 测次顺序重算 / 删除 / 旧数据升级补链 等）、`prevId` 与序号、前一条摘要、当前摘要与字段级前后差异
  - 现场纠错**只追加**更正记录，绝不覆盖旧值；审计字段无变化时不追加（重复操作不多记）；删除业务行追加「删除墓碑」，链条保留备查
  - `/audit` 核对页全库扫描，指出第一条摘要对不上的记录及关联对象，并定性为：内容缺失（首条摘要为空 / 链末摘要与台账当前值不符 / 业务行缺失）、链条断开（序号断裂、`prevId` 接错、前一条摘要对不上）、旧记录未建链
  - 旧数据补链：先快照写入前 `revisions` 全量，写入失败恢复到写入前状态并重试；已有链对象一律跳过，重复操作不多记
- **首屏自动播种**：`initDatabase()` 中 `if (await db.sections.count() === 0) await seedDatabase()`，播种 2 个区间 → 5 个环片 → 6 条裂缝 → 14 个测次 → 4 条建议的互相引用演示数据，并为每条业务行同步落地初始修订链；播种为幂等操作
- **全量 JSON 备份**：含 `revisions`；导入旧版无修订链存档时，对未带链的对象按当时内容补初始链（来源「存档导入补链」）
- **localStorage 辅助键**：`gbtunnelcrack:db-version`（结构版本号）、`gbtunnelcrack:last-backup-at`（最近备份时间）、`gbtunnelcrack:ui-prefs`（上次选中区间、仅看预警开关）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷；清理浏览器数据即清空业务数据（可在 `/backup` 页重新播种）

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22806
npm run build      # vue-tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

> 提示：开发时浏览器直接使用本机 IndexedDB；若与 Docker 版本混用同一浏览器，数据是同一份（同源端口不同则为不同源，数据互相独立）。

## 七、判定口径

- 月均速率 `mm/月 = (本次宽度 − 上次宽度) ÷ 间隔天数 × 30`
- 分级阈值：`< 0.10` 一般，`0.10 ~ 0.25` 较重，`≥ 0.25` 严重
- 预警数 = 速率分级为「较重」及以上的裂缝数量
