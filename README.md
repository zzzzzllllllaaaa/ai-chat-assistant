# AI Chat Assistant

一个 [Obsidian](https://obsidian.md) 插件：多模型对话 + 知识库检索（RAG）+ 能读写你自己笔记的智能体 + 长期记忆与角色扮演。

> **从 v2.0.0 起：完全免费、源码公开（MIT）、不再有激活码。**
> 授权模块已从代码里删除，所有旧激活码作废——也不再需要。曾付费购买过的用户可开 issue 联系退款。

---

## 为什么开源

这个插件的功能正在被各种本地/云端 agent 取代，作者自己也不再用它赚钱了，所以决定不再维护付费授权那一套，直接把源码放开：**能用你就拿去用，能改你就自己改**。也欢迎有人接手把它做得更好。

## 功能

### 🤖 多模型对话
- 支持 OpenAI / Claude / Gemini / 通义千问（DashScope）/ DeepSeek 以及任何 OpenAI 兼容端点
- 流式输出、自定义 Base URL、按用途绑定不同模型（聊天 / 智能体 / 向量）
- 本地模型：可接 Ollama

### 📚 知识库（RAG）
- 混合检索：向量相似度 + 关键词 + 时间衰减，再用 RRF 融合
- 查询改写与结果重排
- 图谱感知：顺着笔记的双链把上下文一并取回
- IndexedDB 存向量、Web Worker 做检索，不阻塞界面

### 🛠️ 智能体
- 工具调用：读写笔记、建文件夹、全文搜索、网络搜索等
- 默认工具零接线自动注册（`registerDefaultTools`）
- 多步任务执行 + 阶段小结

### 🧠 记忆与角色扮演
- 长期记忆：自动抽取用户事实与事件小结
- 角色卡（SillyTavern PNG/JSON 导入）、人格、世界状态、关系图谱

### 🔀 多模型协作
- 助手 → 专家 → 项目经理 → CEO 四级升级
- 按任务复杂度自动路由

## ⚠️ 现状与已知不足（说实话版）

作者自己也觉得这个插件"很多地方没优化好"，公开源码的同时把这些一并说清楚，免得别人踩坑后骂人：

- **DeepSeek 缓存的命中率没有真正优化好**：prompt 前缀不稳定，缓存命中收益远低于预期。
- **Skills 与 MCP 支持是雏形**：MCP 只实现了 HTTP/SSE 传输，没有 stdio，也没有在真实客户端上充分验证；Skills 更多是"能跑通"，不是"能靠"。
- **大文件技术债**：`main.ts` 2500+ 行、`src/ui/views/view.ts` 3200+ 行、`settings-tab.ts` 2000+ 行，拆分工作没做完。
- **没有自动化测试**：只有几个手动跑的脚本，改代码靠人肉验证。
- **内置 HTTP API server 没有鉴权**：默认关闭，只适合本机自用，别暴露到公网。
- **移动端能用但慢**：大仓库的索引与检索在手机上体验一般。

## 安装

插件**未上架 Obsidian 社区插件市场**，手动装：

1. 到 [Releases](https://github.com/zzzzzllllllaaaa/ai-chat-assistant/releases) 下载 `main.js`、`manifest.json`、`styles.css`
2. 在你的 vault 里建目录 `<vault>/.obsidian/plugins/ai-chat-assistant/`
3. 把 3 个文件放进去
4. 重开 Obsidian → 设置 → 第三方插件 → 启用

> GitHub 在国内可能需要自备网络条件。

## 配置（三步）

1. 设置 → AI Chat Assistant → 模型 → 添加连接（名称 / Base URL / API Key）→ 测试连接 → 拉取模型
2. 给"聊天 / 智能体 / 向量"分别绑定模型（用知识库必须配一个可用的向量模型）
3. 要 RAG 就在命令面板执行"更新知识库索引（增量）"

## 开发

```bash
npm install
npm run dev      # esbuild watch
npm run build    # tsc 类型检查 + esbuild 生产构建 → main.js
npm run verify   # 只做类型检查
```

### 目录

```
main.ts               插件入口（注册视图/命令/设置页，装配各服务）
src/core/             设置、类型、插件上下文
src/services/         llm / rag / vector / context / storage / code
src/features/         agent · memory · skills · collaboration · world · roleplay
src/ui/               视图、设置页、各种弹窗、内联补全
src/mcp/              MCP 客户端与工具注册
styles.css            插件样式
```

### 隐私

- 不采集遥测，没有埋点上报
- 对话只发给你自己配置的模型服务；用 Ollama 可以完全离线
- 笔记内容只在本地建索引（IndexedDB）

## 历史版本

见 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT —— 见 [LICENSE](LICENSE)。

作者：**3zh** · [GitHub](https://github.com/zzzzzllllllaaaa)
