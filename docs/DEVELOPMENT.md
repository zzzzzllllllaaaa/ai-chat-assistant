# 开发与发布（作者向）

给使用者看的说明在 [README.md](../README.md) / [README.zh.md](../README.zh.md)。这份只管"我下次怎么改代码、怎么发版"。

## 构建

```bash
npm install
npm run dev      # esbuild watch
npm run build    # tsc 类型检查 + esbuild 生产构建 → main.js
npm run verify   # 只做类型检查
```

## 代码结构

```
main.ts               插件入口（注册视图/命令/设置页，装配各服务）
src/core/             设置、类型、插件上下文
src/services/         llm / rag / vector / context / storage / code
src/features/         agent · memory · skills · collaboration · world · roleplay
src/ui/               视图、设置页、各种弹窗、内联补全
src/mcp/              MCP 客户端与工具注册
shims/                替换 jszip 依赖链里旧浏览器垫片（lie / immediate / readable-stream）
styles.css            插件样式
docs/                 设计文档、排查记录（历史留存，不随 release 发布）
```

## 发版流程

Obsidian 拿 **release 的 tag 与 `manifest.json` 的 `version` 精确对齐**，所以：

1. 改 `manifest.json` 与 `package.json` 的 `version`，`versions.json` 加上 `<版本>: <最低 Obsidian 版本>`
2. `npm run build`
3. commit → 推公开仓库
4. tag **必须是 `2.0.1` 这种形式，不要 `v2.0.1`**（带 `v` 会报「没有任何发布能匹配你的清单版本」）
5. `gh release create <版本号> --notes-file notes.md main.js manifest.json styles.css`

```bash
gh release create 2.0.1 --title "AI Chat Assistant 2.0.1" --notes-file notes.md main.js manifest.json styles.css
```

**构建产物必须用 LF 行尾的 fresh clone 构建**：官方 Build verification 是逐字节比对 release 里的 `main.js` 与"用仓库源码重新构建"的结果，本地 CRLF 工作树构建出来的文本资产（`styles.css` / `manifest.json`）字节数会对不上。

## 公开仓库 = 白名单单提交快照

仓库里有些内容（`.claude/`、`.codebuddy/`、`.workbuddy/`、`test/`、`docs/` 历史文档等）不适合公开，所以公开仓库不是直接把本地历史推上去，而是：

1. 本地维护一份白名单文件列表（`.editorconfig` `.eslintignore` `.eslintrc` `.gitattributes` `.gitignore` `.npmrc` `CHANGELOG.md` `LICENSE` `README*.md` `esbuild.config.mjs` `main.ts` `manifest.json` `package.json` `package-lock.json` `versions.json` `shims/` `src/` `styles.css`）
2. 在干净分支上只放这些文件 → 单提交快照
3. 强推覆盖远端主分支（`git push --force origin <分支>:main`）
4. 强推前先把旧 HEAD 归档成 `archive-<版本>` 分支（`POST /git/refs`，需要完整 40 位 SHA）

⚠️ **强推会重写远端历史**：不可逆，且旧的提交短期内仍能按 URL 访问。执行前必须拿到明确同意。

## 官方社区目录

- 提交/管理入口：<https://community.obsidian.md>（Obsidian 账号 + 连 GitHub）
- 审查按 release 走：**每次发新 release 都会重跑自动审查**；只有 `Error` 阻塞，`Warning` / `Recommendation` 不阻断
- 已踩过的坑：
  - `eslint-plugin-obsidianmd`（与官方同一套）必须 **0 error**：直写元素样式要改成 `setCssStyles({ display: "none" })`（键必须是指识符，字符串键照样报错）、去掉调试 `console.log`、别用 `innerHTML` 拼接、设置页别用 `<h2>`、别把插件实例当 Component 传
  - 包体里出现 `document.createElement("script")` 会被判"动态建 script 元素" —— 本项目来自 jszip 依赖链的 `lie` / `immediate`，已在 `shims/` 用原生实现替换，esbuild 的 `browser` 字段要同时把 `^jszip$` 指到 lib 源码才生效
  - `manifest.json` 的 `description` 用英文一句话、句号结尾；**README 必须含英文**（否则挂 Warning）
  - 关掉 Node 内置模块规则的唯一合法姿势：`Platform.isDesktop` 守卫 + 动态 `import()`（写成 `Platform.isDesktopApp` 不算守卫）
  - 任何 `eslint-disable` 注释都要带 `-- 原因`，且**禁止** disable `obsidianmd/*` 自己的规则

## 网络

本机推 GitHub：HTTPS 走代理上传会静默卡死，用 SSH over 443（`connect.exe` 作 `ProxyCommand`）。`gh` 走 HTTPS，必要时 unset 代理直连。
