# 参与开发

本项目使用原生 JavaScript，开发环境为 Node.js 24 和 npm。扩展本身无需 Node.js 或后台服务器。

```sh
npm ci
npm test
npm run check
```

在 Edge 的扩展管理页加载 `extension` 目录。修改后重新加载扩展并刷新 B站编辑页。Windows 下运行 `npm run package` 会生成与扩展版本对应的 ZIP。

## 提交修改

从 `main` 创建分支，每次提交围绕一个明确问题。提交说明写清楚原来的行为、改动后的行为及实际验证方式。涉及版本发布时，同步更新 `extension/manifest.json`、`package.json` 和 `package-lock.json` 中的项目版本。

新增回归案例优先使用最小合成 HTML。测试不得依赖真实账号、Cookie 或实时网站接口；发布功能不属于当前插件范围。涉及 B站协议的变更，应记录官方编辑器的证据和日期，并区分模拟测试与真实草稿验证。

## 本地测试资料

仓库不包含用户保存的完整文章或账号资料。`测试文章/` 与 `test-artifacts/` 中的可选案例存在时，本地测试会读取它们；干净克隆中对应案例会明确跳过，合成回归继续运行。缺少这些资料不应导致 CI 失败，也不能宣称 CI 已完成真实账号验证。

`node_modules/`、`dist/`、测试截图、真实草稿 JSON 和环境文件均不提交。报告问题时提供去除登录信息的最小复现，不粘贴 Cookie、令牌或网络请求认证头。

原创代码与文档采用 [MIT 许可](LICENSE)。机构标志和文章内容的范围见 [名称与标志](BRANDING.md)，第三方依赖保留各自许可。
