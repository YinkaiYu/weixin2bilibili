<img src="extension/icons/icon-128.png" alt="weixin2bilibili 图标" width="80" height="80">

# 插件：把微信公众号文章导入B站专栏

weixin2bilibili 是物理所内部的 B站运营工具，服务账号「二次元的中科院物理所」。把微信公众号文章导入 B站专栏，在 B站原生编辑器中修改、预览和发布。

粘贴文章链接即可生成新草稿。插件适用于 Edge 和 Chrome，直接在浏览器中运行。

**[下载扩展](https://github.com/YinkaiYu/weixin2bilibili/releases/latest)** · [更新记录](CHANGELOG.md) · [反馈问题](https://github.com/YinkaiYu/weixin2bilibili/issues)

## 能做什么

- 转存正文图片和 GIF 动图，保留公式、上下标、加粗和文字颜色，将图片下方的灰色小字归入图注。
- 清理已识别的装饰、空行、普通外链、回顾栏目和互动推广内容，保留文章出处。
- 自动填入公众号封面、选择原创声明，并匹配 B站文集。
- 在 B站继续编辑正文和发布设置，确认后自行发布。封面图也可以单独下载修改。

## 安装

1. 在 [Releases](https://github.com/YinkaiYu/weixin2bilibili/releases/latest) 下载 `weixin2bilibili-v版本号.zip`，解压到准备长期保留的文件夹。
2. 在 Edge 地址栏打开 `edge://extensions`，启用「开发人员模式」。Chrome 对应 `chrome://extensions`。
3. 点击「加载解压缩的扩展」，选择解压后的文件夹，其中应直接包含 `manifest.json`。

更新时，将新版解压到原安装目录并覆盖文件，在扩展管理页点击「重新加载」，再刷新 B站编辑页。

## 使用

1. 登录 B站，打开 [专栏编辑器](https://member.bilibili.com/york/read-editor)。
2. 点击「导入公众号」，粘贴文章链接，点击「导入为新草稿」。
3. 导入完成后，在打开的草稿中检查正文、封面、原创声明和文集，修改后发布。

在公众号文章页面点击扩展图标，也可以自动带入当前链接。导入面板的「更多」中提供「下载封面图」和「导入本地网页」；本地导入需要选择保存的 HTML 及配套资源文件夹。

## 默认规则

以下默认处理按上述账号的运营需求设置，供其他使用者了解：

- 清理独立的回顾栏目、互动推广和立场声明；明确的回顾、福利互动、投票等尾栏及其后内容不导入。
- 清除普通外链，保留独立「原文链接」出处；B站不支持跳转时保留标题和完整网址。
- 微信专栏名与 B站文集做唯一精确匹配，另有「问答 → 问答Q&A」映射；未匹配或有歧义时留给用户选择。
- 原创声明默认开启，公众号封面作为自定义封面。导入后均可在 B站发布设置中修改。

## 让 Agent 参与贡献

欢迎修复问题、改进文章适配或简化使用流程。把仓库交给你的编程 Agent，再给它一个具体目标：

```text
请克隆 https://github.com/YinkaiYu/weixin2bilibili 。
进入仓库后，阅读 AGENTS.md，了解项目结构和开发约定。
我想改进：[描述问题或想法]。
请完成修改和相关验证，并说明改动效果。
```

开发入口见 [AGENTS.md](AGENTS.md)，提交方式见 [贡献指南](CONTRIBUTING.md)。

## 许可

代码采用 [MIT 许可](LICENSE)。名称和图标的说明见 [BRANDING.md](BRANDING.md)。
