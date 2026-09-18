# AI Chat Assistant（中文说明）

[Obsidian](https://obsidian.md) 插件：多模型对话 + 本地知识库检索（RAG）+ 能读写你笔记的智能体 + 长期记忆与角色扮演。

> **从 v2.0.0 起完全免费、源码公开（MIT）**，代码里已没有激活环节，所有旧激活码作废。曾付费的用户可以开 issue 联系退款。

英文版见 [README.md](README.md)。作者 **3zh** ｜ 协议 **MIT** ｜ 仓库 <https://github.com/zzzzzllllllaaaa/ai-chat-assistant> ｜ [更新日志](CHANGELOG.md)

## 安装

**从社区目录装（推荐）**

1. Obsidian → 设置 → 第三方插件 → **浏览**
2. 搜索 **AI Chat Assistant** → **安装** → **启用**

**手动装（从 GitHub Release）**

1. 到 [最新 Release](https://github.com/zzzzzllllllaaaa/ai-chat-assistant/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`
2. 放进 `<你的库>/.obsidian/plugins/ai-chat-assistant/`
3. 重启 Obsidian → 设置 → 第三方插件 → 启用 **AI Chat Assistant**

需要 Obsidian **1.7.2+**，桌面端与手机端都能跑。

## 快速开始

1. **设置 → AI Chat Assistant → 模型** → 添加连接（名称 / Base URL / API Key）→ 测试连接 → 拉取模型。
2. **按用途绑定模型** —— 聊天、智能体、向量是分开配的（用知识库必须配一个可用的向量模型）。
3. **要用检索**：命令面板执行 `更新知识库索引（增量）`。

用 Ollama 就把 Base URL 填本地地址、Key 留空，可以完全离线运行。

## 功能

- **多模型对话** —— OpenAI、Claude、Gemini、通义千问（DashScope）、DeepSeek 或任何 OpenAI 兼容端点；本地模型走 Ollama；流式输出；按用途绑定不同模型（聊天 / 智能体 / 向量）。
- **知识库（RAG）** —— 混合检索（向量相似度 + 关键词 + 时间衰减）用 RRF 融合，查询改写与结果重排，图谱感知（顺着笔记双链取上下文）；向量存 IndexedDB，检索跑在 Web Worker 里，不阻塞界面。
- **智能体** —— 工具调用（读写笔记、建文件夹、全文搜索、网络搜索等），多步任务执行带阶段小结，动手改东西前会弹权限确认。
- **记忆与角色扮演** —— 长期记忆、角色卡（兼容 SillyTavern）、多角色群聊、写作风格。
- **MCP 工具** —— 接标准 MCP Server（HTTP / SSE）。
- **内联 AI** —— 在编辑器里改写或续写选中内容。

## 隐私与数据

- **无遥测**：插件不含埋点或数据收集代码。
- **网络**只连你自己配置的地址：模型服务、MCP Server、网络搜索、可选的技能/服务接口。
- 对话内容与笔记只发给你配置的模型服务商。配本地模型 + 本地向量库，可以完全断网运行。

以下披露是为了不让你意外：

- **访问 vault 之外的文件** —— 智能体的笔记工具走 Obsidian API，但部分功能（技能安装、导入导出、内置 HTTP API server）会用 Node 的 `fs`，可能读写库外路径；不主动触发就不会碰。
- **执行命令** —— 部分技能功能会通过 `child_process` 跑技能自带的脚本。工具调用有权限确认，但**安装来路不明的技能等于运行它的代码**。
- **剪贴板** —— 用于聊天里的复制/粘贴操作。
- **技能里的动态代码** —— 安装的技能可能以脚本形式执行，只装你信任的。

## 已知不足

- **DeepSeek 提示缓存的命中率没优化好**：prompt 前缀不稳定，缓存收益远低于预期。
- **Skills 与 MCP 是雏形**：MCP 只实现 HTTP/SSE，没有 stdio，也没在大量真实服务上验证过。
- **大文件技术债**：`main.ts` 与 `src/ui/views/view.ts` 各几千行，拆分没做完。
- **没有自动化测试**：改代码靠人肉验证。
- **内置 HTTP API server 无鉴权**：默认关闭、只适合本机，别暴露到公网。
- **移动端能用但慢**：大仓库的索引与检索体验一般。

## 授权

[MIT](LICENSE)。源码公开，Release 里放的是编译产物。

意见与 bug 走 GitHub Issues。个人项目，不承诺维护节奏。
