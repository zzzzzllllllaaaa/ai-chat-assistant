# Changelog

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
