# 2026 桌面端与浏览器插件极简美学 UI 参考素材

本孤儿分支仅存放 UI 重构参考截图与交互原型 `minimal-ui-demo.html`，不修改 `main` 分支代码，也不触发 CI 构建。

## 给接手开发的 AI / 工程师的快速拉取方式

```bash
git fetch origin docs/ui-redesign-2026-assets
git checkout origin/docs/ui-redesign-2026-assets -- docs/ui-redesign-2026
```

- 在本地浏览器打开 `docs/ui-redesign-2026/minimal-ui-demo.html` 可交互预览全部页面、展开状态、图片灯箱、Offer 投票动画、设置页卡片以及「预览手机 App」与「浏览器插件侧边栏」。
- 注意：**生产代码禁止引入任何外部 Tailwind / 字体 / 图标 CDN 运行时**（遵循 `docs/desktop-mvp/workspace-ui.md`），需将样式与线性 SVG 图标收敛到本地 CSS 与前端组件。

## 截图索引

| 序号 | 文件名 | 页面 / 状态说明 |
| --- | --- | --- |
| 01 | `01-applications-collapsed.png` | **投递** — 默认按阶段分组收起、4 列对称 CSS Grid、无阶段下拉框、`已结束 / 未通过` 默认折叠 |
| 02 | `02-applications-expanded.png` | **投递（展开态）** — 原地 7:5 两栏手风琴展开（进度链 + 自动保存备注 \| 跨页联动 + 「当时交的简历」行内展开） |
| 03 | `03-calendar.png` | **日历** — 完整 5 周 35 天月历视图 + 右侧常驻选中日日程详情面板 |
| 04 | `04-inbox.png` | **通知** — Apple Mail 纯白极简两栏 + 底部 AI 识别日程关联确认条 |
| 05 | `05-resume.png` | **简历** — 4 个极细底线 Tab（`简历模板 / 我的信息 / 网站回答 / 附件`）+ 导入入口 |
| 06 | `06-community-desktop.png` | **社区（桌面三栏）** — 微博 + 牛客三栏结构：常驻发图文/投票框、喜报 2 图 + 热评、Offer 投票、3 图面经宫格 + 右侧热搜/茶水间每日一投 |
| 07 | `07-community-mobile.png` | **社区（手机 App 1:1 预览）** — 对应未来移动端卡片流与底部 5 Tab（`投递 · 日历 · 通知 · 简历 · 社区`） |
| 08 | `08-settings-ai.png` | **设置（AI 服务商）** — 左白 7 项导航 + 右浅灰画布 `max-w-2xl` 居中纯白卡片 + 2 列对称表单 |
| 09 | `09-settings-account-sync.png` | **设置（账号与云同步）** — 平台账号 + 可选端到端加密云同步开关（默认仅本机） |
| 10 | `10-extension-sidepanel.png` | **浏览器插件侧边栏** — `360px` 极简 3 Tab（`填写 / 简历字段 / 存邮件`），折叠诊断与反馈，不含任何社区 UI |
