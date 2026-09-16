/*
 * jszip 的 lib/support.js 用 `require("readable-stream").Readable` 判断是否支持 node stream。
 * 走浏览器路径时（jszip 的 browser 字段原本把 "readable-stream" 指到只做 `require("stream")` 的垫片），
 * 在 Obsidian 里既拿不到 node 内置 stream，也不需要这个能力。
 *
 * 这里给一个空实现：`Readable` 为 undefined → jszip 的 support.nodestream = false，
 * 与它在浏览器构建里的行为一致；只有调用 generateNodeStream() 这类 node 专属 API 才会用到。
 */
module.exports = {
  Readable: undefined,
  Writable: undefined,
  Duplex: undefined,
  Transform: undefined,
  PassThrough: undefined,
};
