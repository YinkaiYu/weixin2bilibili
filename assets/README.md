# 标志素材

`iop-logo.pdf` 是项目维护者提供的中国科学院物理研究所矢量标志原文件。扩展中的 PNG 图标从此 PDF 直接渲染，只做等比例缩放和透明边距处理，没有重绘、改色或删除标志内容。

标志及名称的相关权利归原权利人所有，不随本项目代码的开源许可证授权。需要复用标志时，请自行取得相应许可。

重建图标：

```sh
python -m pip install -r scripts/requirements-icons.txt
python scripts/build-icons.py
```

生成位置为 `extension/icons/`，包含 16、32、48、128 和 256 像素 PNG。安装扩展不需要 Python；这些 PNG 已随扩展提供。
