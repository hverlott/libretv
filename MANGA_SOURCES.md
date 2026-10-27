# 漫画源调研报告（2026-10-21）

用户需求：把漫画加进来，并分析 `www.yck2026.fun/index/opplist/tvbox.html` 有哪些可用源。

本文记录完整的探测过程与结论，作为后续维护依据。

---

## 一、yck2026.fun 这个站点

「源仓库」，专门发布阅读（Legado）书源、TVBox 配置的站点。

| 探测项 | 结果 |
|---|---|
| 站点可达性 | ⚠️ **不稳定**。间歇性连接超时，需多重试（3–5 次）才能拿到完整响应 |
| `tvbox.html` 页面 | ❌ **返回「非法请求」**（ThinkPHP 反爬），带 Referer/UA 均无效 |
| 可用入口 | ✅ `/yiciyuan/tuyuan/index.html`（异次元图源列表）、`/yiciyuan/tuyuans/index.html`（图源合集） |
| 图源 JSON 直链 | `https://www.yck2026.fun/yiciyuan/tuyuans/json/id/{ID}.json` |

### 踩坑：这个站的文件是双重编码

图源 JSON 下载下来**不是明文 JSON**，而是 `base64` 包裹的 `zlib deflate`：

```
raw = readFileSync(json)                       // 纯 base64 字符
step1 = Buffer.from(raw, 'base64')             // 得到 x\x9c...（zlib 头）
text = zlib.inflateSync(step1).toString('utf8') // 才是真正的 JSON
```

`gunzipSync` 会失败（不是 gzip 格式，magic 是 `x\x9c` 而非 `x\x1f\x8b`），
必须用 `inflateSync`。GitHub 那个仓库是 `base64 + gunzip`，两处不一样。

另外 `raw.githubusercontent.com` 在本网络**直连不通**，但 `api.github.com` 可用——
用 `Accept: application/vnd.github.raw` 拿原文，否则返回的是 base64 JSON 包装。

---

## 二、75 个漫画源的实测分类

来源：`/yiciyuan/tuyuans/json/id/72.json`（「自用，大部分要梯」，75 源，115KB）。

按**能否被 LibreTV 直接使用**分三类：

### A 类：有 JSON API（4 个）

| 源 | 地址 | 实测结果 |
|---|---|---|
| 拷贝漫画 | `api.mangacopy.com` | ❌ **被墙**。ECONNRESET，走 HTTP 代理复测仍失败 |
| 再漫画 | `v4api.zaimanhua.com` | ⚠️ **搜索可用**，详情需有效 JWT（图源里附的 token 已过期） |
| 新漫画-A | `xapi.xinmanhua.net` | ❌ 端点 404 |
| 漫画皮 | `www.manhuapi.com` | ❌ Cloudflare 防护 + 端点 404 |

**再漫画的可用部分**（已实测）：

```
GET https://v4api.zaimanhua.com/app/v1/search/index?keyword=<kw>&source=0&page=1&size=20
User-Agent: Dart/3.4 (dart:io)
→ { errno: 0, data: { list: [{ id, comic_id, title, authors, cover, status, types, last_name }] } }
```

搜「火影」返回 5 条，字段完整（id / 作者 / 封面 / 状态 / 类型 / 最新章节）。
但详情 `/app/v1/comic/detail/{id}` 恒返回「漫画不存在或已被删除」——
ID 构造规则（`ruleSearchNoteUrl` 里那段 `substring` 逻辑）未能复现，
且 `ruleFindUrl` 里内嵌的 JWT（`exp: 1764395359`）已过期。

### B 类：HTML 规则格式（71 个）

占绝大多数，包含主流国漫/韩漫站：

漫画家、包子漫画、污漫天堂、YYDS、最次元、野蛮漫画、顶漫画、鳥鳥韓漫、
18漫画、Everia 图集、Buondua、绅士会所、魅影画廊 等。

这些源的规则长这样：

```json
{
  "ruleSearchUrl": "https://baozimh.org/s/searchKey?page=searchPage",
  "ruleSearchList": "a[href*='/manga/']",
  "ruleChapterList": "-$.data.data.chapters.*.data.*",
  "ruleContentUrl": "$.chapter_id<js>(function(result,prePage){ ... })"
}
```

即**用 CSS 选择器 / XPath / JSONPath + JS 表达式抓网页**，与 Apple CMS 的
`list` / `vod_play_url` JSON 协议完全不同，**LibreTV 无法解析**。
要在 LibreTV 里用它们，需要实现一套 Legado 规则引擎
（选择器、`@Header:`、`<js>` 内联脚本、正则替换、分页），
工作量约等于重写一个子系统，且这些站点随时可能改版失效。

### C 类：国际公开 API（1 个，最终选用）

**MangaDex**（`api.mangadex.org`）——本次漫画功能的实现基础。

实测全链路打通：

| 环节 | 端点 | 结果 |
|---|---|---|
| 搜索 | `GET /manga?title=X&limit=N` | ✅ 200，54 条（naruto） |
| 详情 | `GET /manga/{id}` | ✅ 200，标题/标签/简介/封面 |
| 章节 | `GET /manga/{id}/feed?translatedLanguage[]=zh` | ✅ 200 |
| 图片 | `GET /at-home/server/{chapterId}` | ✅ 200，返回动态 CDN 地址 |
| 图片内容 | `{baseUrl}/data/{hash}/{file}` | ✅ 200，1.15MB JPEG |

**优点**：全链路可用、有 `contentRating` 分级字段、图片有防盗链但可解。

**缺点**：**中文内容少**。实测《火影忍者》正传中文章节数 **0**
（英文 5 / 日文 0 / 总计 16）。MangaDex 是国际社区，翻译组以英日文为主。
因此客户端做了「中文优先、英文回落」的语言策略（`zh → zh-hk → en → ja`）。

---

## 三、已实现：MangaDex 接入

### 新增文件

| 文件 | 作用 |
|---|---|
| `src/lib/mangadex.ts` | API 客户端：搜索 / 详情 / 章节 / 图片，统一类型，中文优先回落 |
| `src/app/api/manga/search/route.ts` | `GET /api/manga/search?q=X&adult=1` |
| `src/app/api/manga/detail/route.ts` | `GET /api/manga/detail?id=X`（含章节列表） |
| `src/app/api/manga/pages/route.ts` | `GET /api/manga/pages?chapter=X`（返回同源代理地址） |
| `src/app/api/manga/image/route.ts` | `GET /api/manga/image?c=X&i=N` 图片同源代理 |
| `src/app/manga/page.tsx` | 漫画页：搜索列表 + 详情（`?id=` 分发） |
| `src/app/manga/read/page.tsx` | 阅读器：单页 / 条漫两种模式 |
| `src/lib/mangadex.test.ts` | 8 个单元测试 |
| `tests/e2e-manga.cjs` | 端到端测试（Playwright + 系统 Edge） |

导航入口在顶栏「漫画」。客户端面板白名单已加 `/manga` 与 `/manga/`。

### 隐私设计

- **图片必须走同源代理**（`/api/manga/image`），不让浏览器直连
  `*.mangadex.network`——否则用户真实 IP 暴露给 CDN，
  与播放链路走 `/api/proxy` 是同一个道理。
- API 与图片全部 https，无明文泄漏。
- **成人内容用 `contentRating` 字段过滤**，比关键词表准确：
  默认只放行 `safe` / `suggestive`，`erotica` / `pornographic` 需显式 `adult=1`。
  实测默认搜索「ecchi」返回 10 条，成人级 0 条。

### 踩坑记录

1. **`hasCoverArt` 不是合法参数**。MangaDex 对未知参数严格校验，直接返回
   `400 validation_exception`：
   > The property hasCoverArt is not defined and the definition does not allow additional properties

2. **图片 CDN 校验 Referer，不带头一律 404 且 body 为空**。
   极易误判成「链接失效 / 章节不存在」。实测带上
   `Referer: https://mangadex.org/` 即正常返回 `image/jpeg`。
   已在 `src/lib/proxy-handlers.ts` 与豆瓣防盗链并列处理。

3. **`at-home` 的 `data` 与 `dataSaver` 都可能 404**——若整个 CDN 节点对该章节失效。
   判据是 `result: ok` 但具体图片 404，此时换章节而非改代码。

4. **不指定 `translatedLanguage` 时，feed 返回的是小语种优先**
   （实测海贼王 959 章，前排是加泰罗尼亚语 `ca`）。
   必须显式指定语言并按优先级回落。

5. **漫画详情不要用独立动态路由**。原本做了 `/manga/[id]`，但客户端
   （`/app` 前缀）下新增一层动态路由要同时改面板转发白名单与 Next 路由表。
   改用 `?id=` 查询参数后，详情 / 搜索 / 阅读共用一套前缀逻辑，零额外配置。

6. **参数分发必须放在组件顶层**。曾把 `if (id) return <Detail/>` 写进
   `MangaContent`，导致后面的 `useState` / `useQuery` 变成条件调用，
   `react-hooks/rules-of-hooks` 报错。改为外层 `MangaRoute` 分发。

---

## 四、结论与后续方向

**当前状态**：漫画功能已上线，内容来自 MangaDex（国际漫画库，英日文为主）。

**若要国漫/韩漫**，三条路的代价：

| 方案 | 工作量 | 说明 |
|---|---|---|
| 实现 Legado 规则引擎 | 大（≈一个子系统） | 能解锁 71 个源，但站点常改版，维护成本持续 |
| 自建拷贝漫画 API | 中 | 拷贝被墙，需自建服务（Docker），再在 LibreTV 加一个上游地址 |
| 保持现状 | 0 | 英日文漫画 + 中文回落 |

推荐顺序：先用现状，确认内容够用；不够再评估自建拷贝漫画。
