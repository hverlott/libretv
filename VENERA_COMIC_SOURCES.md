# Venera 漫画源调研（w13630039663-bit/venera-miuix）

调研日期：2026-10-22 · 目的：为 LibreTV **漫画板块**找中文源 + 可借鉴的功能

> **状态更新（同日实现）**：再漫画已接入，作为漫画板块的默认源（MangaDex 降为第二源，
> 切换器可切）。实现要点见文末「附：接入后的实现要点」。

---

## 一句话结论

**这个仓库本身用不上**（Kotlin + Compose 写的 Android 阅读器，Web 端无从借鉴），但它牵出了两样真东西：

1. **再漫画 v4 API 已实测全链路打通** —— 纯 JSON、**无需登录**、中文漫画，搜索/详情/章节/图片四个端点全部可用。**这是目前唯一能直接补上 LibreTV 中文漫画缺口的源**（MangaDex 中文仅 642 部）。
2. **33 个源脚本 + 完整协议文档** —— 源是用 **JavaScript** 写的（不是 Legado 那种 HTML 规则），所有宿主能力通过 20 个 `sendMessage` method 桥接，**理论上可在 Node 里复刻宿主直接跑**。

成人向源（禁漫 / nhentai / e-hentai /绅士漫画 / hitomi 等 10 个）**不接入、不展开**。

---

## 一、仓库是什么

| 项 | 内容 |
|---|---|
| 性质 | **非官方社区 Fork**，上游 `venera-app/venera`（Flutter 漫画阅读器） |
| 当前分支 | `compose-migration`：整体重写为 **Kotlin + Jetpack Compose**，新增画廊图站模块 |
| `master` 分支 | Flutter 版（2026-09-16 分叉），**协议文档 `doc/comic_source.md` 在这一支** |
| 平台 | 仅 Android 13+（另有一个未完成的 `:desktop` Compose 模块） |
| 许可 | GPL-3.0 |
| 源仓库 | `venera-app/venera-configs`（**33 个源脚本 + index.json**，最后更新 2026-10-19） |

> 星标数未获取：`api.github.com` 匿名限额 60 次/小时，调研途中触发 403（详见文末环境坑）。

**关键点**：README 里反复强调「协议与官方**逐字兼容**」「shim 层复刻原版 API 面」—— 说明这套 JS 协议是有稳定契约的，不是各写各的。

---

## 二、33 个源脚本盘点

协议判据：`HtmlDocument.parse` / `querySelector` 计数 = HTML 抓取；`JSON.parse` 计数 = 结构化接口。

| 源 | key | 字节 | HTML | JSON | 登录 | 加密 | 判读 |
|---|---|---:|---:|---:|:---:|:---:|---|
| 拷贝漫画 | copy_manga | 38675 | 0 | 15 | ✓ | ✓ | 纯 API，但需 HMAC 签名 + 伪设备 ID |
| 包子漫画 | baozi | 14021 | 34 | 2 | ✓ | ✓ | HTML 抓取为主 |
| Picacg（哔咔） | picacg | 30088 | 0 | 16 | ✓ | ✓ | API + 强签名，**域名本机不通** |
| **再漫画** | **zaimanhua** | **14047** | **0** | **13** | 可选 | — | ✅ **纯 API、已实测可用** |
| 漫画人 | manhuaren | 38730 | 39 | 3 | — | ✓ | HTML 抓取 |
| 爱看漫 | ikmmh | 42688 | 32 | 9 | ✓ | ✓ | HTML + API 混合 |
| comick | comick | 25180 | 1 | 6 | — | — | 英文聚合站，**API 域名本机不通** |
| MangaDex | manga_dex | 41798 | 9 | 0 | ✓ | ✓ | **LibreTV 已接入** |
| 少年ジャンプ＋ | shonen_jump_plus | 14842 | 0 | 2 | ✓ | ✓ | 日文 |
| カドコミ | comic_walker | 10511 | 0 | 3 | — | — | 日文 |
| 优酷漫画 | ykmh | 35701 | 0 | 1 | — | — | 纯 API |
| 漫蛙吧 | manwaba | 10878 | 0 | 1 | — | — | 纯 API |
| 漫画1234 | mh1234 | 17059 | 26 | 0 | — | — | HTML |
| GoDa漫画 | goda | 15204 | 26 | 3 | — | — | HTML |
| 漫小肆 | mxs | 17797 | 35 | 0 | — | ✓ | HTML，**域名不通** |
| jcomic.net | jcomic | 12074 | 19 | 0 | — | — | HTML |
| 嗨皮漫画 | happy | 21813 | 18 | 7 | — | — | 混合，**域名不通** |
| 漫画柜 | ManHuaGui | — | — | — | — | — | 文件名与 key 大小写不一致，未取到 |

**不接入的三类**

- **成人向（10 个）**：禁漫天堂 `jm`、nhentai、e-hentai、绅士漫画 `wnacg`、hitomi.la、18漫画、H-Comic、热辣漫画、MYCOMIC、CCC追漫台
- **自建服务（3 个）**：Komga、Kavita、Lanraragi —— 要用户自己先搭服务器，与 LibreTV 定位不符
- **同源变体**：拷贝漫画(多账号)

---

## 三、实测结果（这是最有价值的部分）

### ✅ 再漫画：全链路可用，无需登录

请求头只需 `User-Agent: Mozilla/5.0 (Linux; Android) Mobile` + `Authorization: Bearer `（**后面留空即可**）。

| 能力 | 端点 | 实测 |
|---|---|---|
| 分类/更新列表 | `GET /app/v1/comic/update/list/{catId}/{page}` | 200，20 条 |
| 搜索 | `GET /app/v1/search/index?keyword=xxx&page=n` | 200，`errno=0`，20 条 |
| 详情 + 章节 | `GET /app/v1/comic/detail/{comicId}` | 200，`data.chapters[].data[]` 含 chapter_id |
| 图片 | `GET /app/v1/comic/chapter/{comicId}/{chapterId}` | 200，`data.page_url[]` 直接是图片 URL |

Base：`https://v4api.zaimanhua.com/app/v1`

**实测样本**（分类列表第 1 页）：`尾巴与逆鳞`(85969，奇幻/日常)、`双生兽族`(88074，校园/奇幻)、`北地之龙`(64645，冒险/魔法/奇幻)

**有价值的字段**
- 详情里有 `types[]`（题材标签，带 tag_id）、`authors[]`、`status`、`islong`
- 章节条目带 **`canRead` / `is_fee` / `chapter_order`** → 付费章可直接标灰，不用点了才报错
- 漫画级有 `is_need_login` → 可提前提示

**分类 ID**（脚本 `categoryParamMap`，部分）：全部 `0`、冒险 `4`、欢乐向 `5`、格斗 `6`、科幻 `7`、爱情 `8`、侦探 `9`、竞技 `10`、魔法 `11`、神鬼 `12`、校园 `13`、惊悚 `14`、其他 `16`、四格 `17`、亲情 `3242`、百合 `3243`、悬疑 `3245`、纯爱 `3246`、热血 `3248`、历史 `3250` …（完整表见源脚本）

⚠️ 注意：搜索参数名是 **`keyword`**，不是 `q` / `wd` —— 写错会返回 `errno=1 请输入搜索的内容`（我第一次就猜错了）。

### ❌ 拷贝漫画：不可用

| 域名 | 结果 |
|---|---|
| `www.copy20.com` | ECONNRESET（被墙） |
| `api.copy-manga.com` | 根路径 404；脚本里的 `/api/kb/web/searchb/comics` 返回 **404 HTML 页面** → 接口路径已改版 |

与既有笔记一致（此前判定"拷贝漫画被墙"）。脚本里的 HMAC-SHA256 签名 + 伪设备 ID 也意味着维护成本高。

### ⚠️ comick：待定

主站 `comick.art` 页面 200（258 KB），但**没有** `__NEXT_DATA__` / `APOLLO_STATE`（没法靠解析页面拿数据）；官方 API 域名 `api.comick.fun` **本机 DNS 不通**、走代理也 502。`api.comick.cc` 返回的是 HTML 壳。需要换环境再确认。

### 其余可达性（Node 直连 / 代理复核）

| 域名 | 结果 |
|---|---|
| `v4api.zaimanhua.com` | ✅ 200 |
| `www.manhuaren.com` | ✅ 200 |
| `appcn.baozimh.com`（包子） | ⚠️ 直连 403 / 代理 200（需 UA + 防盗链） |
| `www.ikmmh.com` | ⚠️ 404（域名可达，路径不对） |
| `www.ykmh.net` | ✅ 200 |
| `www.mxshm.top`、`picaapi.picacomic.com`、`m.happymh.com`、`mwuu.cc` | ❌ 超时 / DNS 失败 |

---

## 四、JS 协议的可移植性评估

源脚本长这样（`class Xxx extends ComicSource`，字段即元数据）：

```javascript
class Zaimanhua extends ComicSource {
  name = "再漫画";  key = "zaimanhua";  version = "1.0.2";
  buildUrl(path) { return `https://v4api.zaimanhua.com/app/v1/${path}`; }
  async search(keyword, page) { const res = await Network.get(...); }
}
```

**宿主只需提供 20 个桥接 method**：

```
delay  convert  uuid  random  http  cookie  html  log
load_data  load_setting  save_data  delete_data  isLogged
image  UI  getLocale  getPlatform  setClipboard  getClipboard  compute
```

暴露给脚本的全局：`Convert`（编解码/md5/hmac/aes/rsa）、`Network`、`HtmlDocument/HtmlElement/HtmlNode`、`Cookie`、`Comic`、`ComicDetails`、`ImageLoadingConfig`、`Image`、`UI`、`APP`

**Node 侧复刻成本**

| 能力 | 实现 |
|---|---|
| `http` | 现成 `undici` / `fetch` |
| `convert` | `node:crypto` + `iconv-lite`（GBK） |
| `html` | 需引入 HTML 解析器（约一半的源要用） |
| `load_data/save_data` | 内存 Map 或本地文件 |
| `UI/log/clipboard/getPlatform` | 可 no-op 或打日志 |

**代价与风险（必须写清楚）**

1. **执行第三方 JS = 远程代码执行面**。必须：`node:vm` 受限 context（不注入 `require`/`process`/`child_process`）+ 单次执行超时 + 只加载**白名单内审核过的脚本**，不能做成"用户粘贴任意 URL 就加载"。
2. **多数源要登录或签名**（33 个里 18 个带登录逻辑），LibreTV 是本机自用，凭据存在本地可以接受，但每个源的登录态维护是持续成本。
3. **上游脚本会漂移**：`venera-configs` 最近更新 2026-10-19，站点一改版脚本就失效（拷贝漫画就是现成例子）。

**结论**：协议可移植，但**为 33 个源引入 JS 引擎不划算**。真正值得做的是**只接再漫画**（纯 JSON，不需要引擎）。

---

## 五、值得借鉴的功能（对 LibreTV 漫画板块）

### 第一梯队：直接能抄

| 功能 | 说明 | 投入 |
|---|---|---|
| **再漫画中文源** | 见上，纯 JSON 全链路 | 半天~1 天 |
| **源测速与健康度** | 并行 ping 各源，首页状态行四态（连通/降级/失败/未知），点击可重测，源列表带耗时色标 | 小（可复用直播测活那套） |
| **每主机熔断** | 2 次失败 / 60 秒自动熔断，可一键重置 | 小（现有 `mapWithConcurrency` 外层加一层） |
| **分级三态** | 不过滤 / **封面打码** / 彻底隐藏 | 小（现在只有开/关两态，中间档"打码"体验更好） |
| **按域 UA / Cookie 策略** | 每个域独立 UA + Cookie（MangaDex 图片 CDN 要 Referer 就是这类问题） | 小 |

### 第二梯队：有价值但要排期

- **阅读器排版增强**：条漫连续、横向画卷、美漫左→右翻页、日漫右→左翻页、对开双页（LibreTV 现在只有单页 / 条漫两档）+ 前瞻预加载 0–20 页
- **自动巡航**：条漫匀速滚动（15–480 px/s），翻页模式定时翻页（1–10 秒/页），触摸暂停
- **跨源聚合搜索**：多源并行、按源分组出结果（接了再漫画后自然会有这个需求）
- **章节完整性三态**：半成品章节标「离线不全」徽章，不伪装成完整 —— 对现有批量下载很实用
- **CBZ 导入/导出**：打包章节目录分享
- **阅读统计**：今日页数、连续天数、题材分布（本机自用，不上传，符合现有隐私架构）

### 不做

- 屏幕防窥（`FLAG_SECURE` 禁截图）—— Web 做不到
- Cloudflare 交互式过盾 —— Web 端不适用
- 画廊图站模块（yande.re / Gelbooru）—— 与影视站点定位无关，且内容风险高

---

## 六、建议顺序

1. **接再漫画**（中文源，已验证，不需要 JS 引擎）— 收益最大
2. 源测速健康度 + 每主机熔断 — 复用现有探测代码
3. 阅读器排版 + 预加载 — 体验提升明显
4. ComicSource JS 引擎 — **仅在确实需要那 33 个源时再做**，注意 RCE 风险

---

---

## 附：接入后的实现要点（踩坑记录）

调研时以为端点摸清了，真接入时又冒出四个坑，**都是实测才能发现的**：

**① `comic/update/list/{catId}/{page}` 的分类参数是假的。**
10 个题材 ID 返回**完全相同**的列表（首条都是「尾巴与逆鳞」）。真正支持筛选的是
`comic/filter/list?theme&zone&cate&status&sortType&page&size`，上游没有"标签列表"接口，
44 个题材 ID 只能内置成静态表（`zaimanhua-tags.ts`）。

**② 同一份数据在三个接口里字段名不同。**
`filter/list` 的标题是 **`name`**（不是 `title`）；`types`/`authors`/`status` 在列表接口是
逗号字符串（`"奇幻,日常"`）、在详情接口是对象数组；章节图片在 **`data.data.page_url`**
（双层 data，少读一层拿到空数组）。

**③ 搜索索引里混着大量已下架作品。**
搜「龙」返回 20 条，前 4 条点进去全是 `errno=2 漫画不存在或已被删除`。
枚举过能零成本判断的字段，全失败 —— 搜索结果把 `last_updatetime` 和
`last_update_chapter_id` **一律置 0**（有效作品也一样），只有 `hot_hits` 有差异但阈值不可靠。
最终做法是并发（6 个一批）逐条问详情过滤，且**验证请求本身失败时保留该条**、
**过滤后一条不剩时退回原列表**（宁可让用户点开看到「已下架」，也不显示"没有找到"这种假象）。

**④ 章节 id 必须自带源信息。**
阅读器翻页时只有章节 id，光靠它要能反解出走哪个源。再漫画的章节 id 编成
`z{漫画id}.{章节id}`，与 MangaDex 的 UUID 天然区分，`/api/manga/image` 不用额外透传参数。

**架构上的两个约束**

- 客户端组件不能导入 `manga-sources.ts`（它依赖 `fetchUpstream`），
  所以源元数据单独放 `manga-source-meta.ts`（纯常量），与 `mangadex-tags.ts` / `zaimanhua-tags.ts` 同一套路。
- 两个源的筛选维度不同但**共用同一组 URL 参数位**（`tags`/`demo`/`status`/`origin`/`sort`），
  取值换成本源的 ID；切源时必须清空旧条件，否则会出现"再漫画题材 ID 被当成 MangaDex 标签 ID"。

**验证**：单测 23 个；e2e 17/17（含图片真实加载、页面未直连上游图床）；
MangaDex 侧回归 7/7 + 12/12 + 13/13 全过。

---

## 附：本次抓取的环境坑（补充到既有笔记）

- `api.github.com` 匿名限额 **60 次/小时**，第二轮就 403 了（重置时间可见于 `/rate_limit`）
- 兜底 `cdn.jsdelivr.net/gh/{repo}@{branch}/{path}`：**Node 直连可用**，curl / Python 走本机代理 SSL 握手失败
- jsdelivr 连续高频请求会偶发取不到内容（返回 null），要加重试
- bash heredoc 里正则的 `\s` 会被吞成 `/s` → 脚本一律写成文件再跑
- 中文文件名走 CDN 要 URL encode（`一木多线路.json` 那次已经踩过）
