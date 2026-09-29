# Changelog

All notable changes to **Crisp Tempo** will be documented in this file.

## [0.1.3] - 2026-09-29

### Fixed
- 左右侧栏都打开、Tempo 面板变窄时，弹窗（项目与周期、设置、新建任务等）偏向右侧并被截掉一半。现在弹窗始终在 Tempo 面板内居中。
- 面板很矮时（如上下分屏），设置和「项目与周期」弹窗改为内容区滚动，「完成」按钮始终可见。
- 窄面板里任务行上的项目标签过长时显示省略号，不再截断到边框外；标签里的彩色圆点不再被挤扁。

## [0.1.2] - 2026-09-29

### Fixed
- 授权服务端明确拒绝（已吊销、激活次数达上限、未包含本插件权限）时授权失效。此前这类响应被当成网络异常而放行。服务不可用、网络错误时仍降级为本地验签。
- 联网校验加 2.5 秒超时，网络卡住时「激活」按钮不再一直转圈。
- README 删去未实现的「领域分组」「标签」描述，补充「等待依赖」视图。

### Changed
- 仓库新增自动化测试：`npm test`（授权校验）与 `npm run test:e2e`（界面端到端），`npm run check` 包含两者。
- 部署与测试脚本不再写死本机路径；部署目标通过 `OBSIDIAN_VAULT`、命令参数或本地 `.deploy-target` 指定。

## [0.1.1] - 2026-09-29

### Added
- 新建任务、子任务和项目需要激活码；未激活时仍可查看、编辑、完成、删除和导出已有任务，顶栏显示「未激活」入口。
- 项目与周期可以编辑和删除（列表顶部「编辑」按钮或侧栏右键）；删除时任务保留，只解除关联，可 ⌘Z 撤销。
- 子任务可以删除，勾选框支持键盘操作。
- 「已完成」记录同时列出已取消的任务。

### Fixed
- 昨天排进「今天」但未完成的任务，过零点后不再从「今天」消失。
- 打开插件时不再自动选中示例任务 `task-1`（窄屏下会遮住整个界面）。
- 每次保存不再插入「正在保存」提示条导致看板上下跳动；仅在保存超过 1.5 秒时提示。
- 项目进度与计数不再把已取消任务算入；点击已取消任务的勾选框会重新打开而不是标记完成。
- 周期的「进行中」标记按起止日期判断，结束的周期不再一直显示。
- 收集箱任务在详情里显示为「收集箱」，可以直接改为「随时」。
- 未打开看板就在插件设置里激活或改偏好，修改不再丢失。
- 导出目录拒绝包含 `..` 的路径。
- 「接下来」按日期排序，项目与周期列表把未完成任务排在前面。

## [0.1.0] - 2026-09-29

### Initial Release
- **Things 3 × Linear Task Engine**: Local-first personal GTD and task management system built specifically for Obsidian.
- **Multi-dimensional Navigation**: Inbox, Today, Upcoming, Anytime, Someday, Logbook, Projects, and Sprints/Cycles.
- **Native macOS & Crisp Suite Translucent Glass**: Fluid glassmorphism UI integrating seamlessly with dark and light Obsidian themes.
- **Full Keyboard Navigation**: Keyboard shortcuts (`⌘+Enter`, `⌘+Z`, `Esc`, `⌘+K` palette integration) for distraction-free rapid task capture.
- **Subtasks & Progress Tracking**: Linear subtask hierarchy with real-time project/cycle KPI calculations.
- **Cycle Management**: Flexible sprint-like cycles with date range validation and automatic active cycle assignment.
- **Reliable Local-first Persistence**: Strict data validation, atomic writes via Obsidian adapter, daily automated snapshots, and full JSON backup export.
- **License Activation**: Sibling Crisp Suite license auto-discovery and offline Ed25519 signature validation.
