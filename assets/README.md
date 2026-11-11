# 图标素材

[`logo.png`](logo.png) 是 weixin2bilibili 的透明 PNG 母图。图标以维护者提供的物理娘形象为参考，将蓝发头像、微信气泡和 B站小电视组合成导入标识。

母图使用内置图片生成工具制作，生成与修整提示词保存在 [`logo-prompt.txt`](logo-prompt.txt)。扩展图标由母图等比例缩小，保留透明通道。

设计参考：

- 物理娘：维护者提供的角色插画。
- 微信气泡：[腾讯官方仓库中的微信标识](https://github.com/Tencent/WeVisOne-VL/blob/main/assets/wechat-logo.png)。
- B站小电视：[B站官网使用的应用图标](https://i0.hdslb.com/bfs/static/jinkela/long/images/512.png)。

名称、角色与平台标识的权利说明见 [BRANDING.md](../BRANDING.md)。

重建图标：

```sh
python -m pip install -r scripts/requirements-icons.txt
python scripts/build-icons.py
```

生成位置为 `extension/icons/`，包含 16、32、48、128 和 256 像素 PNG。安装扩展不需要 Python；这些 PNG 已随扩展提供。
