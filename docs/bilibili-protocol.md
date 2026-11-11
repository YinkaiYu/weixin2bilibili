# B 站原生草稿协议

实现入口：[bilibili.js](../extension/lib/bilibili.js) 负责请求与读回校验，[opus.js](../extension/lib/opus.js) 负责 HTML → Opus。导入流程与模块边界见 [architecture.md](architecture.md)。

## 协议依据

此参考基于 2026-11-11 检查的 B 站公开编辑器构建，版本常量为 `eva3-4.0.0`：

- [原生编辑器入口](https://member.bilibili.com/york/read-editor)
- [官方前端构建 index-iVnxuzkp.js](https://s1.hdslb.com/bfs/static/sunflower/read-editor/assets/index-iVnxuzkp.js)

下表中的字符偏移只用于定位上述构建；更新协议时优先按符号搜索新构建。

| 协议内容 | 官方代码检索入口 |
| --- | --- |
| 段落、文字、公式、图片工厂 | `OpusNodeFactory`，约 900000–904000 |
| 段落格式 | `convertParagraphAttrsToFormat`，895418 |
| 字号与标题档位 | `FontLevel`、`HEADING_STYLES`、`detectHeadingLevel` |
| 文字及主题色反向转换 | `convertWordNodeToAttrsAndMarks`，945743；`colorToString`、`findColorVarByValues` |
| 半高文字底纹 | `Background` 的 `renderHTML`，1611403 / 3355061 |
| 列表分组 | `CombineHashContext`，893337；`rebuildListWithCombineHash`，949048 |
| 图片注释 | `CaptionManager`，1770062；`getImageCaptionFromElement`，1771323 |
| 普通来源链接 | `convertTiptapToLinkNode`，909769；`updateLinkAttributes`，876081 |
| 图片上传 | `uploadImg`，4238939；正文上传调用约 5254109 |

接口不是独立版本化的公开 SDK。更新字段时同时检查写入器、读取器和原生渲染器：字段能被保存，不一定能按源 HTML 显示。

## 请求与响应

API 基址为 `https://api.bilibili.com`。会话与 `bili_jct` CSRF cookie 由扩展后台处理；JSON 响应以 `code === 0` 表示成功，业务内容在 `data`。

| 用途 | 方法与路径 | 请求 / 返回 |
| --- | --- | --- |
| 登录状态 | `GET /x/web-interface/nav` | `data.isLogin`、`mid`、`uname`、`face` |
| 文集 | `GET /x/article/creative/list/all` | `data.lists[]`：`id`、`name`、`total` |
| 图片上传 | `POST /x/dynamic/feed/draw/upload_bfs` | multipart：`file_up`、`biz=new_dyn`、`category=daily`、`csrf` |
| 来源链接识别 | `POST /x/v2/dynamic/sunflower/parse?csrf=...` | JSON `{raw_texts:[url]}`；`data.parsed_items[url]` |
| 保存草稿 | `POST /x/dynamic/feed/article/draft/add?csrf=...` | JSON `{arg:{...}}`；`data.article_id` |
| 读取草稿 | `GET /x/dynamic/feed/article/draft/view?article_id=...` | `data.draft` |

草稿编辑地址为 `https://member.bilibili.com/york/read-editor?aid=<article_id>`。适配器只实现草稿保存，不调用发布接口。

### 保存对象

`buildDraftPayload()` 是完整字段的唯一实现来源。影响导入行为的字段如下：

| 字段 | 当前值 / 含义 |
| --- | --- |
| `type`、`template_id`、`category_id`、`private_pub` | `4`、`1`、`15`、`2` |
| `title`、`summary` | 文章标题；摘要截取至 250 个 JavaScript 字符 |
| `original`、`reprint` | 原创声明 `1/0`；转载选项独立为 `0` |
| `list_id` | 文集 ID；未选择为 `0`；读回优先取 `draft.list.id` |
| `image_urls` | 自定义封面数组；首项决定封面；空数组表示清除 |
| `article_id` | 可选的已知草稿 ID；一般新建导入不传 |
| `opus.opus_source` | `2` |
| `opus.title`、`opus.content` | 标题与 `{paragraphs:[...]}` |
| `opus.pub_info.editor_version` | `eva3-4.0.0` |
| `opus.attachments.is_aigc` | `0` |

`comment_selected`、`up_closed_reply`、`timer_pub_time`、`only_fans_level`、`only_fans_dnd` 当前均为 `0`。`sourceLinks` 是插件内部的允许列表，不属于发送给 B 站的 `arg`。

## Opus 内容结构

| 内容 | 数据结构 |
| --- | --- |
| 普通段落 | `{para_type:1, format, text:{nodes}}` |
| 图片段落 | `{para_type:2, pic:{pics:[...], style:0}}` |
| 分割线 | `{para_type:3, line:{line_type:1}}` |
| 引用 | `{para_type:4, format, text:{nodes}}` |
| 有序 / 无序列表 | `para_type:5/6`，`format.list_format:{level,order,theme}`，`format.combine_hash` |
| 代码块 | `{para_type:8, code:{lang,content}}` |
| 标题 | `para_type:9`，`format.heading_type:1/2/3`，`text.nodes` |
| 文字节点 | `{node_type:1, word:{words,font_size,font_level,color,dark_color,style,...}}` |
| 来源链接节点 | `{node_type:4, link:{show_text,link,link_type:16,...}}` |
| 行内公式节点 | `{node_type:5, formula:{latex_content}}` |

`format.align` 为左 `0`、中 `1`、右 `2`。缩进在 `format.indent`，包含 `first_line_indent` / `indent`。没有已确认的两端对齐值。列表 `combine_hash` 是分组标识；编辑器会重新生成其值。

### 字号、颜色、底纹

文字 `style` 支持 `bold`、`italic`、`strikethrough`、`underline`。正文档位为 `13/small` 和 `17/regular`。标题档位分别为 `24/xxLarge`、`22/xLarge`、`20/large`，对应 `heading_type:1/2/3`。原生 CSS 决定最终显示尺寸、字重与段间距，不能用任意 `font_size` 声称保存了任意 CSS 字号。

颜色字段接受 CSS 颜色字符串。`bili_theme` 优先于 `color`；`Wh0` 的明暗颜色为 `#FFFFFF` / `#17181A`，`Ba0` 为黑 / 黑。白色使用显式 `Wh0` 配对；其它自定义颜色不主动近似到调色板。

`bg_style:{style:1,color:{color,dark_color,bili_theme?}}` 表示**半高底纹**。官方渲染器固定输出 `linear-gradient(transparent 50%, COLOR 50%)`，且读取器只接受 `style === 1`。它不是完整文字底色，也没有已确认的段落整块背景字段。依赖全高底色的浅色文字应由清理/转换策略单独处理。

### 公式与上下标

文字节点没有原生 `sup/sub` 字段。转换器将相邻字母基底与上下标组合为 LaTeX 节点，保留同段位置、粗斜、下划线和可表示的颜色。已有 `data-formula` / `data-latex` 只读取最外层源码，不重复转换内层 SVG。

公式颜色只能使用可表示为 TeX 颜色的值；CSS `rgba(...)` 不能直接放入 `\color{...}`。背景、水平删除线等不能准确表达的公式样式会产生 `blockingIssues`。不存在已确认的通用行内位图节点；位图与文字混排由局部渲染路径处理。

### 图片和注释

图片字段为 `{url,width,height,size,comment?}`。上传响应字段为 `image_url`、`image_width`、`image_height`、`image_size`，兼容 `img_size`。保留 API 返回的 `size`；仅字段缺失时用字节数除以 1024，原始字节数另存 `bytes`。

图片 URL 限定 B 站 CDN 的 `/bfs/` 路径。上传文件扩展名和 MIME 从文件头识别，GIF 不经画布重编码；上传后核对动画格式、帧数与播放时序。

`comment` 是图片下方原生注释，最多 100 个 UTF-16 代码单元，不支持富文本或换行。官方 HTML 导入读取 `data-caption` 或最近 `figure` 中的 `figcaption`。一图一注可转换为 `comment`；长图注、强调、彩色、上下标或来源链接保留为下方正文。

上传 API 的服务端尺寸阈值没有稳定的公开定义。原生前端文件检查中的 20MB / GIF 8MB，以及封面裁剪界面的 600×336，分别属于前端文件限制与封面 UI 约束，不能据此推导全部正文图片的服务端宽高规则。扩展自身的传输和渲染限制见架构文档。

### 来源链接

普通链接使用 `node_type:4`、`link_type:16`，字段包括 `show_text`、`link`、`icon`、`icon_suffix`、`biz_id`、`pics`、`style`。`style.font_size` 使用 `0`，`font_level` 可为 `small/regular`；支持粗斜、删除线、下划线与底纹。前景色由 B 站链接主题控制，链接内不能嵌套公式节点。

结构合法与平台认可分开处理。`validateSourceLinks()` 按最多 50 个 URL 分批调用官方识别接口：

| 返回项 | 处理 |
| --- | --- |
| `type:1, link_type:16` | `accepted`，允许原生普通链接 |
| `type:0` | `rejected`，保留标题与完整可复制网址 |
| 缺项、未知类型、格式错误、请求失败 | `failed`，同样保留标题与完整网址并提示未确认 |

原生编辑器会把识别失败的链接降为普通文字，因此最终转换必须传入识别结果。支持原生结构但无法保留自定义前景色、公式或上下标的来源内容，也走保全正文和完整网址的路径。

## 保存读回校验

`verifyDraft()` 比较转换后的预期与 `data.draft`：标题、原创、文集、自定义封面、段落顺序、文字、公式、字号、颜色/主题、强调、背景、图片 URL/宽高/顺序/图注及来源链接。源文件格式在媒体阶段检查，上传后的动画另行下载核对；静态图片不做逐像素比对。正文比较不比较服务端重新报告的图片 `size`。

已实现的等价形式有明确边界：

- `i0.hdslb.com` 与 `article.biliimg.com` 的同一完整 BFS 路径及查询参数；保留裁剪后缀和其它域名差异。
- `align:0` 与省略、空 `indent:{}`、图片 `style:0` 与省略、代码 `lang:''` 与省略。
- 黑色与官方黑色 `Ba0`；白色加 `Ba0` 仍是颜色变化。
- 列表分组 ID 改名；比较组成员关系，拆分、合并、层级和顺序变化仍有差异。
- 原生链接官方定义的空字符串、空数组、布尔 `false`、字号默认值；非默认字段、URL、显示文字和节点类型仍参与比较。

新增归一化时，为该等价形式增加正例，并增加相邻的真实内容变化反例。不要把服务器改字号、丢链接或改变图片路径当作默认值差异。

## 修改入口与验证

| 变更 | 代码 | 对应测试 |
| --- | --- | --- |
| API、草稿字段、链接识别、读回比较 | [bilibili.js](../extension/lib/bilibili.js) | [bilibili.test.js](../tests/bilibili.test.js) |
| HTML → 节点、样式与公式 | [opus.js](../extension/lib/opus.js) | [opus.test.js](../tests/opus.test.js) |
| 文件识别、上传缓存、动画 | [media.js](../extension/lib/media.js) | [media.test.js](../tests/media.test.js) |
| 出处 URL 规范化 | [source-links.js](../extension/lib/source-links.js) | [source-links.test.js](../tests/source-links.test.js) |
| 完整导入与恢复 | [native-controller.js](../extension/lib/native-controller.js)、[background-handlers.js](../extension/lib/background-handlers.js) | [native-controller.test.js](../tests/native-controller.test.js)、[bridge.test.js](../tests/bridge.test.js) |

运行 `node --test tests/bilibili.test.js tests/opus.test.js tests/media.test.js tests/source-links.test.js`。本地补充样稿和已存 API 响应的回归入口是 `real-opus.test.js`、`bilibili-live.test.js`；缺少本地材料时会跳过。协议结构测试与浏览器显示验证分别覆盖不同问题。
