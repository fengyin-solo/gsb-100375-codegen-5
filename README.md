# 水文监测站网管理系统

面向水文监测站点运行、水位流量雨量数据采集、遥测设备维护与数据整编发布的水文站网管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 监测站点 | `station` | 水文监测站 | 站点编号、站点名称、站点类型 |
| 水位监测 | `waterlevel` | 水位记录 | 记录编号、站点编号、观测时间 |
| 流量监测 | `discharge` | 流量记录 | 记录编号、站点编号、测量方法 |
| 雨量观测 | `rainfall` | 雨量记录 | 记录编号、站点编号、观测时段 |
| 水质检测 | `waterquality` | 水质检测报告 | 报告编号、采样站点、采样时间 |
| 断面测量 | `crosssection` | 断面测量记录 | 记录编号、站点编号、断面名称 |
| 遥测设备 | `telemetry` | 遥测设备 | 设备编号、设备类型、所属站点 |
| 数据整编 | `compilation` | 整编成果 | 成果编号、整编年份、站点编号 |
| 预警阈值 | `warning` | 预警阈值配置 | 配置编号、站点编号、监测类型 |
| 地下水观测 | `groundwater` | 地下水观测记录 | 记录编号、井点编号、观测日期 |
| 蒸发观测 | `evaporation` | 蒸发观测记录 | 记录编号、站点编号、观测日期 |
| 测流缆道 | `cableway` | 测流缆道 | 缆道编号、所属站点、跨度米数 |
| 泥沙监测 | `sediment` | 泥沙监测记录 | 记录编号、站点编号、采样时间 |
| 通讯系统 | `communication` | 通讯设备 | 设备编号、设备类型、所属站点 |
| 站房维护 | `stationhouse` | 站房维护记录 | 记录编号、站点编号、维护类型 |
| 仪器检定 | `calibration` | 仪器检定记录 | 记录编号、仪器编号、仪器名称 |
| 巡检记录 | `inspection` | 巡检记录 | 记录编号、站点编号、巡检日期 |
| 测报方案 | `plan` | 测报方案 | 方案编号、方案名称、适用范围 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `hydrology-monitor-station:entries` 这一项，或调用 `resetModule(模块)`。

## 雨量资料交接：先对账后入档

雨量观测页下方内嵌「资料交接对账」工作台（`views/rainfall/HandoverPanel.vue`），业务规则全部在
`frontend/src/api/handover-service.ts`，流程为：

1. **导入交换文件**：CSV 前两行可选 `交换号`、`来文单位` 元信息，随后是
   `站点编号,观测时段,时段雨量,日累计雨量,降雨强度,观测人,校核人,班次` 表头与数据行；
   也可「载入样例交换文件」直接体验。
2. **先对账**：按「站点编号 + 观测时段」配对，逐字段标出一致 / 冲突 / 仅站点有 / 仅交换有，
   时段雨量与日累计雨量给出数值差（mm）。冲突字段由值班员逐字段选择**采纳站点原值或交换文件**，
   也可一键统一裁定。站点侧「已通过」的历史观测时段**只读兼容**，只展示差异、永不覆盖。
3. **确认覆盖范围**：勾选本次入档的「站点 + 观测时段」，并登记观测人、校核人、班次，
   三者随入档结果逐行写入（行级凭证），交换行缺凭证时用本次值班登记补齐。
4. **下载双向交换清单**：出站（站点提供）、入站（交换来文）、双向核对、历史只读逐行可追溯的 CSV。
5. **确认入档**：雨量记录按裁定结果 upsert（交换新增行补登记），状态置为已通过；
   **数据整编页同步补一条「待核对」成果**（带来源交换号），核对通过后转待审核。

其他保证：

- **同一交换号并发确认只落一个版本**：交换号台账
  （`hydrology-monitor-station:rainfall-handover-ledger`）在入档时原子抢占并回读校验，
  重复建单/重复确认都会被拦下。
- **中断后从差异行继续**：对账草稿持久化在
  `hydrology-monitor-station:rainfall-handover`，记录第一个未处理差异行的游标，
  重新打开自动定位。
- 冒烟脚本覆盖完整链路：`cd frontend && npm run test:handover`。
