# Changelog

## 2.0.1

**上架准备版：按 Obsidian 官方审查规则（`eslint-plugin-obsidianmd`）把阻塞项清零，功能不变。**

### 修复（审查阻塞项）

- `minAppVersion` 1.5.0 → **1.7.2**（用到 `Workspace.revealLeaf`）
- `manifest.json` 描述改英文一句话（≤250 字符、句号结尾）；README 补英文段落（审查要求）
- `styles.css` 修掉一处多余的 `}`（CSS 语法错误）
- 去掉插件初始化时对 DOM 的直接样式写入（287 处）与调试用 `console.log`（67 处）
- `MarkdownRenderer.render` 不再传入插件实例，改用短生命周期 `Component`（避免内存泄漏）
- 消息渲染里的 `innerHTML` 拼接改为 `createEl` / `setText`；设置页标题改用 `setHeading()`
- 内联 `eval` / `new Function` 与动态脚本元素的检查项：把 jszip 依赖链里的旧浏览器垫片（`lie`/`immediate`/`setimmediate`）换成原生实现，包体不再出现 `document.createElement("script")`
- 依赖 `diff` 5.2.0 → ^5.2.2（安全公告）

### 说明

- 构建产物 `main.js` 由 esbuild 生成，`npm run build` 可逐字节复现
- 已知警告（不影响审核通过）：中文 UI 的 sentence-case 提示、`document.createElement` → `createEl` 建议等

## 2.0.0

**这次是一次"减法"版本：砍掉授权系统，源码公开。**

### Breaking changes

- 删除 `src/license/LicenseManager.ts` 与 `src/ui/modals/ActivationModal.ts`
- 移除 3 处功能门禁（智能体、知识库、高级模式）与设置页里的「激活状态」面板
- 清理 `licenseInfo` / `licenseExpiryRemindedAt` 设置字段与相关引用
- 清理 `styles.css` 中的 `.ai-license-*` 样式

> 影响：**所有旧激活码失效，且不再需要。** 插件全部功能免费开放，不再连任何授权服务器。
> 曾付费购买过的用户可开 issue 联系作者退款。

### 关于版本号

1.9.11 → 2.0.0 是一次不兼容的结构变更（设置字段与授权行为都变了），也算这个项目从"商业尝试"转向"免费开源"的分界线。

### 已知不足

详见 README「现状与已知不足」一节。简述：DeepSeek 缓存命中率没优化好、Skills 与 MCP 仍属雏形、`main.ts` / `view.ts` 等大文件拆分未完成、无自动化测试。
