/**
 * 宿主入口的转发。
 *
 * DSH 按**包内相对路径**找宿主半（`<包>/lib/index.js`），不走 `exports`——2026-10-30 实测：
 * 只把 `exports["."]` 指到 `plugin/lib/index.js` 时，启动报
 * `failed to import: ENOENT … node_modules/@jackiehank/dsh-kiln/lib/index.js`。
 * 客户端半则相反，是按 `exports["./client"]` 解析的，所以那边不用转发。
 *
 * 于是：包根只在 `lib/index.js` 留这一层 `export *`，实现仍然只有一份（`plugin/lib/index.js`）。
 * 改插件时别改这里；这里没有逻辑。
 */
export * from '../plugin/lib/index.js'
