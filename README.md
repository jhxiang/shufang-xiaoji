# 书房小记 · 阅读记录与洞察

一个极简安静的个人阅读记录 App。书架上以竖立**书脊**陈列藏书，点开即展开封面卡片；搭配专注计时、语音/拍照读书笔记、人物关系导图、每日五条摘录与阅读时段分析。

同时提供三种形态：

| 形态 | 说明 | 是否需要签名 |
| --- | --- | --- |
| **网页 / PWA** | 部署到 GitHub Pages，Safari「添加到主屏幕」即全屏使用 | 不需要 |
| **iOS App（未签名 .ipa）** | GitHub Actions 自动构建，可用 SideStore / Sideloadly / iLoader 自签安装 | 需要自签，7 天续签 |
| **本地开发** | `python3 -m http.server` 直接预览 | — |

---

## 功能一览

### 1. 书架（主页）
- **书脊视图**：未选中时以竖立书脊呈现，书脊宽度随字数、高度随页数自然变化，带真实书脊高光与底边进度条。
- **展开封面**：轻点书脊从书架隔板上平滑展开为完整封面卡片，含题材/状态/页数/字数/评分标签、阅读进度条与四个快捷操作（计时 · 笔记 · 详情 · 读毕）。
- **状态筛选**：全部 / 在读 / 想读 / 已读。
- **双维度分类**：按题材 / 按作者切换，自动生成带数量的分类胶囊。
- **排序**：最近阅读、评分最高、进度优先、字数、最新录入。
- **深度搜索**：可搜书名、作者、题材、简介、读后感正文、人物姓名。

### 2. 阅读计时
- 顶部一键进入专注计时，实时时钟 + 暂停/继续 + 结束保存。
- 计时状态持久化，切后台或退出 App 后回来仍继续累计。
- **环境音**：细雨 / 炉火 / 静夜，全部由 Web Audio 实时合成，零音频文件。
- 手动补记：填写分钟数 + 时间点，补录过往阅读。

### 3. 读书笔记
- 三种类型：读后感 · 书摘划线 · 纸质扫描。
- **语音输入**：原生 `SFSpeechRecognizer`（App 内）/ 浏览器 `SpeechRecognition`（网页）。
- **拍照扫描 + OCR**：原生 `Vision` 识别中文书页文字，自动追加到笔记；网页端降级为保存图片 + 可选豆包识图。
- 可关联页码 / 章节，笔记可一键生成分享卡片。

### 4. 人物关系
- **人物扉页**：姓名、身份、色调徽章、性格关键词、人物小传、代表台词。
- **交互式思维导图**：SVG 画布，节点可拖动、画布可平移，点击节点编辑人物、点击连线编辑关系。
- **关系色调**：中性 / 亲情 / 爱情 / 对立（虚线）/ 师徒，带方向箭头。
- 一键自动排版，导出 1040×760 高清关系图。

### 5. 每日拾页
- 每天 5 条精华摘录，混合内置经典书摘与你自己划线的书摘。
- 收藏到书房、生成竖版书摘卡片（750×1000 Canvas，可保存/分享）。
- 「换一批」按日期与偏好重新洗牌。

### 6. 荐书
- 内置 28 本中外经典元数据（书封文字排版 / 简介 / 页数 / 估算字数）。
- 基于已读题材、作者偏好、评分的本地推荐算法。
- 可选接入**豆包 AI**（火山方舟），生成个性化荐书与深度阅读画像。

### 7. 阅读洞察
- 年度目标环 + 连续阅读天数。
- 累计时长、已读字数、笔记条数、平均评分四项 KPI。
- **24 小时活跃热力图** + 六个时段柱状分布，自动判断「清晨早鸟型 / 午后沉浸型 / 深夜书房型 / 均衡型」。
- 题材偏好条形图、偏爱作者、评分分布。
- AI 阅读画像（配置豆包 Key 后可用）。

### 8. 数据与外观
- 日间纸白 / 夜间护眼 / 跟随系统三档主题。
- 全部数据存本机 IndexedDB（被禁用时自动降级 localStorage）。
- 一键导出完整 JSON 备份（App 内直接唤起系统分享，可存 iCloud Drive），恢复时智能合并去重。
- 内置 4 本示例书（含人物图谱与阅读记录），可随时清空重置。

---

## 版权合规

联网搜书仅抓取**封面、简介、页数、估算字数**等元数据，**不获取、不存储、不展示任何正文内容**。界面中明确标注「版权合规元数据」。

---

## 本地开发

```bash
# 起一个静态服务器（Service Worker 需要 http/https）
python3 -m http.server 8899
# 浏览器打开 http://127.0.0.1:8899/index.html
```

目录结构：

```
.
├── index.html            # 单页结构：4 个主页面 + 7 个底部弹层
├── styles.css            # 双主题变量、书脊 3D、导图、计时器
├── app.js                # 状态管理、存储层、全部业务逻辑
├── catalog.js            # 28 本精选书 + 35 条经典书摘
├── audio.js              # Web Audio 环境音合成
├── mindmap.js            # SVG 人物关系导图 + PNG 导出
├── manifest.webmanifest  # PWA 清单
├── sw.js                 # 离线缓存
├── icon.svg / icon-*.png / AppIcon-1024.png
├── scripts/sync-web-assets.sh   # 同步 Web 资源到 iOS bundle
├── ios/                  # SwiftUI + WKWebView 原生外壳（XcodeGen）
│   └── ShufangXiaoji/
│       ├── ShufangXiaojiApp.swift   # @main 入口
│       ├── WebAppView.swift         # WKWebView + JS Bridge
│       ├── LocalSchemeHandler.swift # shufang://app/ 本地协议
│       ├── VisionOCR.swift          # Apple Vision 文字识别
│       ├── DictationService.swift   # 语音听写
│       └── PersistentStore.swift    # 原生磁盘快照
└── .github/workflows/    # Pages 部署 + 未签名 IPA 构建
```

---

## iOS 打包

原生外壳由 SwiftUI + `WKWebView` 组成，本地资源通过自定义协议 `shufang://app/` 提供，因此 IndexedDB / localStorage 均有稳定 origin。

原生能力（`window.webkit.messageHandlers.shufangBridge`）：

| 消息 | 作用 |
| --- | --- |
| `fetchUrl` | URLSession 代理网络请求，绕开跨域限制 |
| `shareFile` | base64 写入临时文件并唤起系统分享面板 |
| `recognizeOcr` | Vision 框架识别照片文字 |
| `startDictation` / `stopDictation` | 中文语音实时听写 |
| `setTheme` | 同步外观到原生状态栏 |
| `pickPhoto` | 原生相机 / 相册选择 |
| `saveSnapshot` / `clearSnapshot` | 数据落盘到 App 沙盒（自定义 scheme 下 IndexedDB 不可靠） |

### GitHub Actions 自动构建

推到 `main` 后 `Build unsigned iOS IPA` 工作流会：

1. 安装 XcodeGen 并生成 `.xcodeproj`
2. `xcodebuild -configuration Release -sdk iphoneos` 构建（关闭签名）
3. 打包为 `Payload/ShufangXiaoji.app` → `ShufangXiaoji.ipa`
4. 校验 IPA 内含 `WebApp/index.html` 与图标
5. 上传为 Actions artifact（保留 90 天）

### 本地 Xcode 构建

```bash
./scripts/sync-web-assets.sh
cd ios
xcodegen generate
open ShufangXiaoji.xcodeproj
```

### 安装未签名 IPA

用 **SideStore / Sideloadly / iLoader** 自签安装即可；免费开发者账号需每 7 天续签一次。

---

## Web 端降级策略

| 能力 | App 内 | 网页端 |
| --- | --- | --- |
| 数据存储 | 原生磁盘快照（Application Support/snapshot.json） | IndexedDB（异常时 localStorage） |
| OCR | Apple Vision | 豆包识图（需 Key）/ 仅保存图片 |
| 语音 | SFSpeechRecognizer | SpeechRecognition（Safari 支持）/ 提示不可用 |
| 分享图片 | 系统分享面板 | `navigator.share` → `a[download]` 兜底 |
| 联网搜书 | URLSession 代理 | 直接 fetch（Google Books → Open Library → 内置精选） |

> **为什么 App 内不用 IndexedDB？** WKWebView 在自定义 URL scheme（`shufang://`）下对 IndexedDB / localStorage 的持久化并不可靠，可能出现「退出 App 后数据消失」。因此 App 内改为「内存数据 + 原生 JSON 快照」：Web 端每次写入后防抖 320ms 调用 `saveSnapshot` 桥接，原生写入 `Application Support/ShufangXiaoji/snapshot.json`；启动时由 `WKUserScript` 在 `documentStart` 注入 `window.__shufangSnapshot`，页面同步读取即可秒开。App 切后台或即将终止时，原生还会主动调用 `window.__shufangFlush()` 强制落盘。

---

## 豆包 AI（可选）

在「设置」填入火山方舟 API Key 即可启用：

- 模型默认 `doubao-1-5-pro-32k-250115`（也可填 `ep-xxxx` Endpoint ID）
- 接口默认 `https://ark.cn-beijing.volces.com/api/v3/chat/completions`
- Key 只存在本机，不上传任何服务器

启用后可用的两项功能：**AI 荐书**（4 本）、**AI 阅读画像**（150–220 字）。
