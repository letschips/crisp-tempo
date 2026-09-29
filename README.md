# Crisp Tempo

> **Tasks, in motion.**  
> 专为 Obsidian 打造的 Things 3 × Linear 独立个人任务与周期管理系统。本地优先、键盘驱动、优雅沉浸。

[![Obsidian](https://img.shields.io/badge/Obsidian-v1.10.2%2B-blue.svg)](https://obsidian.md)
[![License](https://img.shields.io/badge/license-Proprietary-red.svg)](LICENSE)
[![Crisp Suite](https://img.shields.io/badge/Crisp-Suite-orange.svg)](https://github.com/letschips)

---

## 🌟 特色功能 (Highlights)

### 1. Things 3 的轻盈优雅 × Linear 的严密节奏
- **经典 GTD 视图矩阵**：内置收集箱（Inbox）、今天（Today）、接下来（Upcoming）、随时可做（Anytime）、将来也许（Someday）、等待依赖（Waiting）与已完成（Logbook，含已取消任务）。
- **敏捷周期（Cycles / Sprints）**：引入现代开发流的周/双周敏捷周期管理，自动识别当前活跃周期，支持周期范围排期校验。
- **项目管理**：侧栏列出全部项目（Projects）及完成百分比，可随时改名、换色或删除（删除时任务保留）。

### 2. 键盘优先与极速心流 (Keyboard-First Flow)
- **快捷键全局咬合**：
  - `⌘ + Enter` 或 `Enter`：极速提交新任务并保留编辑节奏。
  - `⌘ + Z`：完整的快照级事务撤销系统，新建、编辑、重置均可一键回滚。
  - `Esc`：秒级退出编辑与关闭弹出层。
  - 方向键 `↑ / ↓`：在待办列表间无缝穿梭聚焦。
- **macOS 原生毛玻璃质感**：沉浸式半透明高光边缘与圆角卡片，完美咬合 Obsidian 官方暗色与亮色主题。

### 3. 子任务与进度追踪 (Hierarchy & Progress)
- **多层级任务树**：支持为任意任务拆分子任务，即时计算父任务与项目的完成度。
- **属性检视抽屉**：独立 Inspector 侧边面板，快速调整状态、优先级、所属项目、规划时期、所属周期与截止日期，并管理子任务。

### 4. 100% 本地优先与隐私安全 (Local-First & Zero-Telemetry)
- **干净空白初态**：全新安装开箱即用，默认创建纯净的空白数据库，绝不携带任何测试数据或隐私残留。
- **标准 JSON 存储**：所有数据均存储在 `.obsidian/plugins/crisp-tempo/data.json` 中，结构清晰，可随时通过外部脚本审计。
- **防丢自愈快照**：插件启动时自动生成每日快照（`data.json.bak-YYYYMMDD`），支持设置面板一键导出完整备份到库内指定目录。

### 5. Crisp Suite 家族无感激活 (License)
- **同门插件自动继承**：若保险库中已安装并激活其他 Crisp 插件（如 Crisp Mind、Crisp Pulse 等），Crisp Tempo 会在启动时自动发现并无缝继承全家桶授权。
- **离线密码学验证**：内置 Ed25519 嵌入公钥，授权码先在本地验签。激活时、以及每次启动加载任务数据时，会在后台联网核对一次吊销状态与设备数，服务端明确拒绝时授权失效；网络不可用、请求超时（2.5 秒）或服务暂不可用时自动降级为本地验签，不影响使用。
- **激活范围**：未激活时可以查看、编辑、完成、删除和导出已有任务；新建任务、子任务和项目需要激活码。

---

## 🚀 安装方式 (Installation)

### 方式 1：通过 BRAT 插件安装（推荐）
1. 在 Obsidian 中安装并启用 **Obsidian42 - BRAT** 插件。
2. 打开命令面板（`⌘ + P`），搜索并选择 `BRAT: Add a beta plugin for testing`。
3. 输入本仓库地址：`letschips/crisp-tempo`。
4. 点击 `Add Plugin`，安装完成后在“第三方插件”列表中启用 **Crisp Tempo** 即可。

### 方式 2：手动下载安装
1. 前往本仓库的 [Releases](https://github.com/letschips/crisp-tempo/releases) 页面，下载最新的发行包文件：
   - `manifest.json`
   - `main.js`
   - `styles.css`
2. 在您的 Obsidian 保险库目录中，进入 `.obsidian/plugins/`，新建文件夹 `crisp-tempo`。
3. 将下载的 3 个文件复制到 `crisp-tempo` 文件夹中。
4. 重启 Obsidian 或在设置中重新加载插件，启用 **Crisp Tempo**。

---

## ⚙️ 软件授权与许可 (License)

Crisp Tempo 为专有商业软件（Proprietary Software），版权归作者 **letschips** 所有。用户可通过购买 Crisp Suite 全家桶或单款激活码获取正式授权。详细条款请参阅 [LICENSE](LICENSE)。

- **作者主页**：小红书 [@letschips](https://xhslink.cn/m/3MwtKu4822b)
- **公众号**：来吃薯条儿
