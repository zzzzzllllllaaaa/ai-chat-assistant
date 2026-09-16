/*
 * `lie` 是 jszip 传递依赖里的旧浏览器 Promise polyfill。
 * 它在检测 setImmediate 时会走 `document.createElement("script")`，
 * 静态审查（Obsidian 插件上架的 "Code obfuscation: Code creates script elements at runtime"）
 * 会因此判定插件运行时创建 script 元素。
 *
 * 运行环境是 Obsidian（Electron / Capacitor WebView），原生 Promise 一定存在，
 * polyfill 分支永远不会真正执行 —— 直接用原生 Promise 替掉，行为不变、审查通过。
 */
module.exports = Promise;
