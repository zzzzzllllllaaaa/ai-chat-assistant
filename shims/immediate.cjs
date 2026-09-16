/*
 * `immediate` / `setimmediate` 都是 jszip 依赖链里的"异步调度"垫片。
 * 它们在老浏览器分支里会走 `document.createElement("script")`（IE 的 setImmediate 兜底），
 * 静态审查（Obsidian 上架检查 "Code creates script elements at runtime"）会判定插件运行时创建 script 元素。
 *
 * Obsidian 里 (Electron / Capacitor WebView) 永远走不到那个分支。
 * 这里换成微任务队列实现，保持 FIFO 顺序与同步抛错语义，行为等价。
 */
const tasks = [];
let scheduled = false;

function drain() {
  scheduled = false;
  const list = tasks.splice(0, tasks.length);
  for (const fn of list) {
    try {
      fn();
    } catch (e) {
      // 与宿主实现一致：回调里抛错不该影响后续任务
      window.setTimeout(() => {
        throw e;
      }, 0);
    }
  }
}

function immediate(task) {
  tasks.push(task);
  if (!scheduled) {
    scheduled = true;
    Promise.resolve().then(drain);
  }
}

// 各依赖包的清理 API（实际用不到，但保持接口存在）
immediate.clear = function () {};
immediate.clearImmediate = function () {};
immediate.setImmediate = immediate;

module.exports = immediate;
module.exports.default = immediate;
