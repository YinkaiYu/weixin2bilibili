# 发布版本

安装包通过 [GitHub Releases](https://github.com/YinkaiYu/weixin2bilibili/releases) 分发。发布工作流在推送 `v*` 标签时运行，完成测试、扩展检查、打包后创建 Release。

## 准备版本

使用 Node.js 24，在 `main` 上完成待发布修改并更新以下文件：

- `extension/manifest.json`：扩展版本。
- `package.json` 和 `package-lock.json`：保持相同版本。
- `CHANGELOG.md`：新增 `## 版本号` 条目，以用户可见的变化描述本次更新。
- 功能或操作方式变化时，同步 README 和安装包内的 `extension/使用说明.md`。

以 `0.1.10` 为例：

```sh
npm ci
npm test
npm run check
npm run package -- --tag v0.1.10
```

标签必须与三个版本文件一致。打包程序按固定顺序和时间戳创建 ZIP，再逐文件验证解压内容；包内根目录直接包含 `manifest.json`。

生成的安装文件：

```text
dist/weixin2bilibili-v0.1.10.zip
dist/weixin2bilibili-v0.1.10.zip.sha256
```

将 ZIP 解压到临时目录，在 Edge 加载该目录，检查导入入口及本次变更涉及的行为。`dist/` 留在本地，安装文件由发布工作流上传。

## 推送与发布

提交版本文件，确认工作区干净，然后创建带说明的标签：

```sh
git tag -a v0.1.10 -m "Release v0.1.10"
git push origin main
git push origin v0.1.10
```

只推送本次发布的标签。首次发布前，将 `origin` 设置为 `https://github.com/YinkaiYu/weixin2bilibili.git`，并确认仓库允许运行 GitHub Actions。

[`release.yml`](../.github/workflows/release.yml) 分为两个作业：构建作业只有读取权限，运行测试并生成安装包；发布作业校验 SHA-256 后创建 Release，上传 ZIP 和校验文件。Release 正文取自 `CHANGELOG.md` 的对应版本条目。

发布后，在 Releases 检查版本、更新说明和两个下载文件，再确认 README 的「下载扩展」指向新版本。

## 日常检查

[`ci.yml`](../.github/workflows/ci.yml) 在 `main` 提交和 Pull Request 中运行，覆盖 Windows 与 Linux。普通提交只执行检查和打包；发布由版本标签触发。

安装包仅包含 `extension/`，不包含测试资料、开发文档、账号信息或依赖目录。图标来源与第三方代码许可的说明随扩展一并分发。
