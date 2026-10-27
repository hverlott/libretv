# LibreTV 本地部署说明

> 版本：2.19.7（Next.js 15.5.26）｜ 部署方式：本地源码 + 生产构建 ｜ 目录：`C:\Users\hverl\WorkBuddy\libertv`

## 一、访问方式

| 入口 | 地址 | 访问密码 |
|---|---|---|
| 本机 | http://localhost:8080 | 见 `.env` 的 `PASSWORD` |
| 局域网 | 默认关闭，见下方说明 | 同上 |

局域网访问默认不开（同网段任何设备都能连，密码是唯一防线）。
需要手机 / 电视访问时，打开站内「系统」页点「开启局域网访问」，
或直接在 `.env` 写 `LAN_ACCESS=1`，然后重启服务——地址会显示在系统页上。
Windows 还需双击「放行防火墙.bat」放行入站端口，否则手机连不上。

版本核对：访问 http://localhost:8080/api/status ，返回的 `version` 字段即运行版本。

## 二、目录结构

```
libertv/
├── .env                 # 实际生效的环境变量（已 gitignore）
├── .env.example         # 环境变量模板
├── 启动系统.bat          # 双击启动（Windows）
├── 停止系统.bat          # 双击停止（Windows）
├── 查看状态.bat          # 双击查看状态（Windows）
├── 启动系统.sh           # 启动（Git Bash / Linux / macOS）
├── 停止系统.sh           # 停止（Git Bash / Linux / macOS）
├── 放行防火墙.bat        # 放行局域网入站端口（右键以管理员身份运行）
├── 打开客户端.bat        # 桌面客户端（双击运行）
├── 打开客户端.sh         # 桌面客户端（Git Bash）
├── start.sh / start.bat  # 传统启动脚本（前台阻塞）
├── scripts/
│   └── ctl.mjs          # 一键启停控制脚本（start/stop/restart/status/install/…）
├── client/
│   ├── launch.mjs       # 客户端启动器（起面板服务 + 拉起独立窗口）
│   ├── panel-server.mjs # 控制面板服务（含 LibreTV 反向代理）
│   └── panel/           # 控制面板页面（index.html + panel.js）
├── .runtime/            # 运行状态（PID / 端口 / 启动时刻 / 日志，可安全删除）
├── downloads/           # 批量下载的产物落盘目录
├── package.json
├── next.config.ts       # DOCKER_BUILD=1 时切 standalone 输出
└── src/
    ├── app/             # 页面与 API 路由
    │   ├── api/         # auth / search / proxy / live / download / system ...
    │   ├── live/        # 直播页
    │   ├── system/      # 系统控制页（一键启停）
    │   └── watch/       # 播放页
    ├── components/
    └── lib/             # auth / api-guard / cms-parser / download-queue / server-download ...
```

## 三、日常运维命令

### 桌面客户端（推荐）

双击 `打开客户端.bat`（Git Bash 用 `打开客户端.sh`），会打开一个**独立窗口**（无浏览器地址栏）：

| 功能 | 说明 |
|---|---|
| 状态卡片 | 运行状态、访问地址、端口、进程 PID、已运行时长、识别方式 |
| 开启服务 | 服务未运行时一键启动 |
| 关闭服务 | 一键停止（按进程树终止，不留孤儿进程） |
| 重启服务 | 停止后重新拉起 |
| 用浏览器打开 | 在系统浏览器里访问（不占用客户端窗口） |
| **进入系统看电影** | 在客户端窗口内直接打开 LibreTV 播放器，同源导航、全屏与 Cookie 均正常 |
| 服务日志 | 实时查看 `.runtime/libretv.log` 尾部 |

客户端的实现：本地控制面板服务（`client/panel-server.mjs`，127.0.0.1:9099）+ 浏览器 app 模式窗口。
**不用 Electron** 是因为本机启用了代码完整性策略（要求企业签名级别），
未签名的 Electron 二进制会被系统直接拦截；浏览器是微软签名的，app 模式能提供同样的独立窗口体验。

### 脚本启停

项目根目录有三个**可双击运行**的脚本：

| 脚本 | 作用 |
|---|---|
| `启动系统.bat` | 启动服务（自动构建 → 后台运行 → 打开浏览器） |
| `停止系统.bat` | 停止服务（按进程树终止，不留孤儿进程） |
| `查看状态.bat` | 查看 PID / 端口 / 运行时长 / 开机自启状态 |

Git Bash / Linux / macOS 用 `启动系统.sh` / `停止系统.sh`（用法相同）。

它们都基于同一个控制脚本 `scripts/ctl.mjs`，也可以直接命令行调用：

```bash
node scripts/ctl.mjs start [--port 8080] [--no-build] [--no-open] [--foreground]
node scripts/ctl.mjs stop [--force]
node scripts/ctl.mjs restart [--port 8080]
node scripts/ctl.mjs status          # PID / 端口 / 运行时长 / 开机自启
node scripts/ctl.mjs install         # 开机自启
node scripts/ctl.mjs uninstall       # 取消开机自启
node scripts/ctl.mjs logs [--lines 100]
node scripts/ctl.mjs verify          # 存活自检（退出码 0=存活）
```

**站内还有「系统控制」页**（`/system`，顶部导航「系统」）：显示运行状态，
提供关闭 / 重启按钮。启动必须从外部发起（双击脚本）——服务停了就没有进程能执行「启动」了。

### 传统方式

```bash
# 启动（自动构建 + 运行，端口默认 8080）
./start.sh              # Git Bash
start.bat               # Windows CMD

# 指定端口
./start.sh 8090

# 手动分步
npm run build && npm start

# 开发模式（热更新）
npm run dev

# 单元测试 / 类型检查 / Lint
npm test
npm run typecheck
npm run lint
```

停止服务：在运行服务的终端按 `Ctrl+C`，或用 `停止系统.bat`。

### 运行状态文件

控制脚本在 `.runtime/` 下维护状态（可安全删除）：

| 文件 | 内容 |
|---|---|
| `libretv.pid` | 服务进程 PID |
| `libretv.port` | 监听端口 |
| `libretv.started` | 启动时刻（epoch ms），用于算运行时长 |
| `libretv.log` | 服务标准输出与错误（追加模式） |
| `build.stamp` | 上次构建时间戳，用来判断是否需要重新构建 |

**状态识别是双路的**：先用 PID 文件，PID 文件丢了就退到端口探测。
所以即使 `.runtime/` 被清空，`status` 仍能正确报告「运行中」。

## 四、环境变量说明

已写入 `.env` 的配置：

| 变量 | 值 | 说明 |
|---|---|---|
| `PASSWORD` | （必填，无默认值） | 访问密码。请用 8 位以上的自有口令；局域网开放时它是唯一防线 |
| `COOKIE_SECURE` | `false` | 纯 HTTP 部署，Cookie 不带 Secure 标记 |
| `REQUEST_TIMEOUT` | `8000` | 代理上游请求超时（ms） |
| `MAX_RETRIES` | `1` | 代理重试次数 |
| `DEBUG` | `false` | 调试开关 |
| `DEFAULT_SOURCES` | 31 个点播源 | 预置采集站（27 个常规 + 4 个成人源），详见下方「点播源清单」 |
| `DEFAULT_LIVE_SOURCES` | 1 个直播源 | 预置 M3U，实测 510 个频道 |
| `DEFAULT_ADULT_FILTER` | `false` | 成人内容过滤默认值（关闭）。仅对未在设置里主动改过的用户生效 |

常用可选变量（未配置时用默认值）：

- `PROXY_SECRET` — 会话/代理签名密钥，默认从 `PASSWORD` 派生；多实例部署建议显式设置
- `DEFAULT_SUBSCRIPTIONS` — 预置远程订阅地址 JSON 数组
- `DEFAULT_RECOMMEND_SOURCE` — 首页推荐源，可选 `douban` / `bangumi` / `hot-list`（默认 `hot-list`）
- `DEFAULT_IMAGE_MODE` — 封面图加载方式，默认 `direct`
- `DEFAULT_ADULT_FILTER` — 成人内容过滤默认值，`false` / `0` / `off` / `no` 表示关闭；`true` / `1` / `on` / `yes` 表示开启。**仅作默认值**：用户在「设置 → 首页与内容过滤 → 成人内容过滤」里主动改过之后，以用户的选择为准
- `60S_API_BASE` — 60s API 实例地址，默认 `https://60s.viki.moe`
- `LIVE_ALLOW_PRIVATE` — 设为 `1` 允许直播代理访问内网（自建 IPTV 场景）

隐私保护相关（详见 [PRIVACY.md](./PRIVACY.md) 与站内 `/privacy` 页面）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `UPSTREAM_PROXY` | 未设置（直连） | 出站代理。所有上游请求统一经代理节点出去，源站与 CDN 看到的是代理 IP。支持 `socks5://` / `socks5h://` / `http://` / `https://`。**SOCKS5 由代理端解析域名**（`socks5://` 与 `socks5h://` 行为一致），本机不做 DNS 查询 |
| `LAN_ACCESS` | `0` | 设为 `1` 允许局域网访问（手机 / 电视同网可用）。开启后密码是唯一防线，建议配合强密码 |
| `BIND_HOST` | （空） | 直接指定绑定地址，优先级高于 `LAN_ACCESS`。如 `192.168.31.100` 只在该网卡监听 |
| `PRIVACY_REQUIRE_HTTPS` | `1`（开启） | 强制 HTTPS 上游。拒绝明文 `http://` 的公网采集站——否则运营商的 DPI 设备能直接看到 `?wd=战狼` 这样的搜索词。设 `0` 可关闭（内网自建源始终放行） |
| `DOH_RESOLVE` | `0`（关闭） | 开启后 DNS 解析走 DNS-over-HTTPS（Cloudflare / AliDNS），运营商看不到你查了哪些采集站域名。适合没有出站代理时使用 |
| `DOH_ONLY` | `0`（关闭） | 配合 `DOH_RESOLVE=1`：DoH 不可用时直接失败，**绝不回落系统 DNS**（宁可不可用也不泄漏查询） |

> 隐私相关的默认行为已内置，无需额外配置即生效：
> 播放走同源代理（浏览器不直连上游）、片名不出现在 URL 查询串、
> 观看历史与搜索历史加密落盘、代理 CORS 收紧为仅同源、
> 全局 `Referrer-Policy: no-referrer`、禁止搜索引擎收录、
> **明文 HTTP 公网源被直接拒绝**。
>
> 想让运营商连 DNS 查询都看不到，加 `DOH_RESOLVE=1 DOH_ONLY=1`；
> 想让运营商连目标 IP 都看不到，再加 `UPSTREAM_PROXY=socks5://127.0.0.1:9050`。

批量下载相关（未配置时用默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOWNLOAD_DIR` | `<项目目录>/downloads` | 下载落盘目录，可用绝对路径 |
| `DOWNLOAD_FORMAT` | `MP4` | 输出格式，`MP4`（fMP4 转封装）或 `TS`（原始流直接拼接） |
| `DOWNLOAD_CONCURRENCY` | `2` | 同时下载的集数 |
| `DOWNLOAD_SEGMENT_CONCURRENCY` | `8` | 单集内的分片并发数 |
| `DOWNLOAD_MAX_EPISODES` | `200` | 单次批量提交的最大集数（超出截断） |
| `DOWNLOAD_MIN_FREE_MB` | `1024` | 剩余空间低于此值时拒绝开新任务 |

## 五、点播源清单

预置 31 个点播源，全部经服务端实测验证：可搜索 + 详情可取到 m3u8 播放地址（2026-10-21）。

其中 4 个标记为 `isAdult: true`（成人源），本机自用部署已通过 `DEFAULT_ADULT_FILTER=false` 关闭过滤，自动勾选参与搜索：

| 源名 | 接口地址 | 详情页 |
|---|---|---|
| 森林资源 | https://slapibf.com/api.php/provide/vod | — |
| 森林资源(备) | https://beiyong.slapibf.com/api.php/provide/vod | — |
| 艾旦影视(成人) | https://lovedan.net/api.php/provide/vod | — |
| 仓库资源 | https://hsckzy.vip/api.php/provide/vod | — |

其余 27 个常规源：
| 源名 | 接口地址 | 详情页 |
|---|---|---|
| 360 | https://360zy.com/api.php/provide/vod | — |
| 360资源 | https://360zyzz.com/api.php/provide/vod | https://360zy.com |
| 360影视 | https://360zy.tv/api.php/provide/vod | — |
| 豪华 | https://hhzyapi.com/api.php/provide/vod | https://www.haohuazy.com |
| 极速 | https://jszyapi.com/api.php/provide/vod | https://jszyapi.com |
| 量子 | https://cj.lziapi.com/api.php/provide/vod | — |
| 暴风 | https://bfzyapi.com/api.php/provide/vod | https://bfzy.tv |
| 虎牙 | https://www.huyaapi.com/api.php/provide/vod | — |
| 百度 | https://api.apibdzy.com/api.php/provide/vod | — |
| 飘零 | https://p2100.net/api.php/provide/vod | https://p2100.net |
| 无尽 | https://api.wujinapi.com/api.php/provide/vod | — |
| 速博 | https://subocaiji.com/api.php/provide/vod | https://www.subozy.com |
| 猫眼资源 | https://api.maoyanapi.top/api.php/provide/vod | https://www.maoyanzy.com |
| 猫眼影视(新) | https://maoyanzy.com/api.php/provide/vod | https://maoyanzy.com |
| 秒播 | https://api.zeqaht.com/api.php/provide/vod | — |
| 全民影视 | http://www.cmov.cn/api.php/provide/vod | — |
| 新浪 | https://api.xinlangapi.com/xinlangapi.php/provide/vod | https://xinlangapi.com |
| 非凡影视(cj) | https://cj.ffzyapi.com/api.php/provide/vod | https://cj.ffzyapi.com |
| 非凡影视(ffzy5) | http://ffzy5.tv/api.php/provide/vod | — |
| 金鹰 | https://jyzyapi.com/api.php/provide/vod | — |
| 爱奇艺 | https://iqiyizyapi.com/api.php/provide/vod | https://iqiyizyapi.com |
| 猫眼资源 | https://api.maoyanapi.top/api.php/provide/vod | https://www.maoyanzy.com |
| 魔都资源 | https://www.mdzyapi.com/api.php/provide/vod | https://www.moduzy.net |
| 最大资源 | https://api.zuidapi.com/api.php/provide/vod | https://zuida.xyz |
| U酷影视 | https://api.ukuapi88.com/api.php/provide/vod | https://www.ukuzy.com |
| 光速资源 | https://api.guangsuapi.com/api.php/provide/vod | https://api.guangsuapi.com |
| 优质 | https://api.yyzy-tv.vip/inc/apijson.php | — |
| 天堂 | http://caiji.dyttzyapi.com/api.php/provide/vod | http://caiji.dyttzyapi.com |

**直播源**：`https://live.zbds.top/tv/iptv4.m3u`（实测 510 个频道，CCTV/卫视/地方台等）

**来源与筛选说明**：

- 来源：GitHub 上的 LibreTV 专用源订阅仓库（`ljfbin2/tv-sources`、`jwscankuLv/LibreTV-sources`、`haojun19980728-prog/libretv-source-list`、`Crest10086/libretv-sources`）、TVBox 配置仓库（`2hacc/TVBox`、`Dong-learn9/TVBox-zyjk`、`cluntop/tvbox`、`qirenzhidao/tvbox18`）、以及 LibreTV issue #892 中用户分享的源清单
- 流程：提取 → 过滤成人源 → 走 LibreTV 服务端接口实测搜索 → 验证详情可取 m3u8 → 同站点按品牌去重（保留 https / 短路径变体）→ 写入 `DEFAULT_SOURCES`
- 剔除项：成人内容源、`/at/xml` `/at/json` XML 通道（LibreTV 不支持）、中转代理地址（`pz.v88.qzz.io` 之类）
- 约 80% 的候选源实测失败，原因是源自身失效或被网络阻断，与部署无关：`ENOTFOUND`（域名已废）、`ECONNRESET`（连接重置）、`ERR_SSL_PACKET_LENGTH_TOO_LONG`（DNS 污染返回假 IP）

**源会失效**：采集站域名生命周期短，失效后可在设置 → 源管理里删掉，或在 `.env` 中替换为新地址后重启。

改完 `.env` 后需重启服务生效。

## 六、热门剧集列表（新增功能）

首页在豆瓣推荐下方新增「热门剧集」区块，**数据全部来自用户自己的点播源**——列出的每部剧都能直接播放，不用再搜一遍。

**热度排序逻辑**（采集站没有「热门榜」接口，实测 `type` / `orderby` / `h` 参数全部被源忽略，只能自己合成）：

| 信号 | 权重 | 说明 |
|---|---|---|
| 收录源数量 | 主信号（每源 100 分） | 全网 31 个源都有的剧才是真热门，比单源打分可信得多 |
| 豆瓣评分 `vod_douban_score` | ×6（0-60 分） | 跨源一致，比源站自评分可信 |
| 源站评分 `vod_score` | ×4（0-40 分） | 单源打分常年虚高，权重压低 |
| 播放量 `vod_hits` | log 压缩后 ×30 | 避免单个爆款拉平整个榜单 |

**分类 tab**：全部 / 电影 / 剧集 / 动漫 / 综艺 / 短剧 / 纪录片 / 体育 / 成人。源站分类名各站不同（电影片/大片、连续剧/电视剧…），已按一级分类（`ac=list` + `type_id_1`）归并为统一分类。成人分类独立成类（不再混进 `other`），与内容过滤共用同一份关键词表，避免「归类成成人却没被过滤」这类错位。

**地区筛选**（分类 tab 下方一行）：全部地区 / 国产 / 欧美 / 英国 / 日本 / 韩国 / 台湾 / 香港 / 泰国。

源站**没有「地区」这个一级分类**——海外内容混在「连续剧/电视剧」下面，只能靠二级分类名（欧美剧/日本剧/韩国剧…）和 `vod_area` 字段推断。两者分工：

- `vod_area` 更精确（写的是「美国」「日本」这种具体国家），但常缺失或写成多国并列（`日本 / 韩国 / 中国香港`）；
- 二级分类名覆盖面广，但粒度粗——「日韩剧」这种合称会同时命中日韩。

判定规则：**area 是单一国家时以 area 为准**（更准），area 缺失或并列多国时才用分类名；「日韩剧」这类合称分类统一归到「其他」——否则按规则顺序会被算进其中一个国家，另一半的内容就找不到了。

这个维度就是找 HBO / Netflix / 日韩剧的关键：HBO 系剧集（中央情报局、联邦调查局、旺达在哪里、流人第六季）在「剧集 + 欧美」下直接可列。

**内容过滤联动**：热门剧集与搜索共用客户端的「成人内容过滤」开关。关闭后（`DEFAULT_ADULT_FILTER=false`）成人内容正常出现在列表与搜索结果中，成人分类 tab 也可用。

**内容筛选（新增）**：设置 →「偏好设置 → 首页与内容」里有独立的「内容筛选」：

| 选项 | 效果 |
|---|---|
| 全选（默认） | 不按评分过滤；成人内容仍按上方开关单独过滤 |
| 只看有评分 | 只显示**有评分且达到门槛**的条目 |

「只看有评分」模式下还会出现**评分门槛**滑块（0–10，步进 0.5，默认 6 分）。

- 作用范围：首页的**影视推荐区**（豆瓣热门 / 豆瓣周榜 / 百度热播剧 / Bangumi 每日放送）
  与**热门剧集**（浏览区），两者统一口径。
- **百度热播剧与 Bangumi 本身没有评分**，开启「只看有评分」后会被整体隐藏——
  这是预期行为（该模式的意思是「宁缺毋滥，只看有口碑的」）。
- 评分来源：豆瓣推荐 / 豆瓣周榜用豆瓣分（0–10），热门剧集用跨源聚合出的豆瓣分。

**成人内容判定已统一**：改造前存在**三份**成人关键词表副本，其中 `cms-parser.ts`
那份还不完整（缺「成人」「色情」「情色」「麻豆」等词），导致同一内容在搜索结果里被过滤、
在首页却露出来。现在词表只有一份（`src/lib/adult-keywords.ts`），
判定逻辑统一在 `src/lib/content-filter.ts`，各内容区口径一致。

**性能设计**（首屏浅取 + 后台递进深翻）：

源站的列表按更新时间倒序，电影等更新量少的分类被挤到很后面（实测前 3 页几乎取不到电影，翻到 20 页才够），但深翻页代价很高——每页 1-2.5 秒，31 源 × 12 页串行约 474 秒。

因此拆成两段：

- **首屏**：每源只抓 3 页（覆盖最新更新的剧集/综艺），31 源约 8 秒返回
- **后台递进**：响应后按 3 → 12 → 30 页逐档加深，每档完成即更新缓存并失效旧聚合结果
- 实测唯一片名增长：569 → 2288 → **5000**（约 40 秒完成）
- 前端在预热期间显示「正在持续补充更深的内容」，预热结束自动刷新一次拿最新结果
- 原始数据缓存 20 分钟，切换分类/地区只重新聚合（20-110ms），不重爬源
- 卡片显示「N 源」徽章（N = 有几个源收录），点击打开详情弹窗可直接换源

**点击后的流程**：点卡片 → 详情弹窗（显示各集数、简介、源切换条）→ 点集数 → `/watch` 播放。

**新增文件**：
- `src/lib/browse-parser.ts` — 聚合、分类与地区归并的纯函数层（44 个单测覆盖）
- `src/app/api/browse/route.ts` — 服务端聚合接口
- `src/components/browse-section.tsx` — 首页区块组件

## 七、直播体检（一键检测直播能否连接）

直播页主栏新增「直播体检」面板，一键检测所有已启用直播源的全部频道，并给出汇总统计。**不需要一个个点频道看状态**。

**面板能力**：

| 功能 | 说明 |
|---|---|
| 一键检测全部 | 一次检测全部已启用源的所有频道（不受当前搜索/分组筛选影响） |
| 快速 / 精确 模式 | 快速 = 只验入口可达（快）；精确 = 追到分片并采样带宽（准但慢） |
| 实时进度 | 进度条 + 百分比 + 预计剩余时间，随时可取消（已完成的结果保留） |
| 汇总统计 | 频道总数 / 正常 / 弱验证 / 限速 / 失效 / 超时 / 未测 |
| 按源统计 | 每个订阅源的可播比例条，一眼看出哪个源整体挂了 |
| 隐藏失效台 | 一键在频道列表中隐藏判定失效的频道（与侧栏共享状态） |

**两种模式的实测对比**（510 个频道）：

| 模式 | 耗时 | 可达 | 说明 |
|---|---|---|---|
| 快速（只验入口） | 27 秒 | 455/510 | 批量筛死台用，够用 |
| 精确（追分片+测速） | 101 秒 | 442/510 | 能识别「能播但卡顿」的限速源 |

差异：快速模式把 8 个实际可播的源误判为死，精确模式多找出 21 个真死台。**先快速筛一遍，再对可疑的源精确复检**是最省时的用法。

**性能优化的两个关键点**（实测把快速模式从 57 秒压到 27 秒）：

1. **同 host 限流对快速模式放宽**：完整探测追到分片，压力大，同 host 在途必须 ≤3（否则会打挂弱源）；快速模式只发一次入口 GET 就断开，负载极轻，可以放宽到 12。实测有个别死源（如 `219.159.147.195:9901`，26 个频道）每个都要等满 10 秒才超时，严格限流下这 26 个串起来要 90 秒——而它们本来就是死的，串行等再久也不会活。
2. **客户端批并发从 2 提到 5**（仅快速模式），服务端单请求上限 50 条不变。

**探测口径**（服务端三级递进）：入口 → master variant → media playlist → 真实分片，分片用 `Range: bytes=0-1` 只取响应头。结果 level 标识强度：`segment`（分片级，最可信）/ `manifest` / `head`（直链单探）。另外会采样 128KB 带宽估算 kbps，低于 1Mbps 标记为「限速」（绿点却播不了的主因）。

**结果共享**：体检面板与频道侧栏共用同一份结果缓存（store + IndexedDB，6 小时有效），体检完侧栏的状态点会同步亮起，切换分类/分组不重复检测。

**新增/改动文件**：
- `src/components/live-health-panel.tsx` — 体检面板（新增）
- `src/components/use-live-probe.ts` — 探测状态提到 store，两个面板共享同一轮探测
- `src/lib/host-gate.ts` — 同 host 限流支持按模式区分上限
- `src/app/api/live/probe/route.ts` — 新增 `fast` 参数与分级缓存键
- `src/components/live-channel-list.tsx` — 应用「隐藏失效台」

## 八、一键多选下载（批量下载）

热门剧集与搜索结果两处都支持**勾选多部影片 → 一次提交 → 服务端批量下载**。

**为什么下载放服务端**：浏览器端每集都要弹一次「另存为」，多选批量会变成弹窗地狱；且依赖 Cache Storage 断点，受浏览器存储配额限制。服务端直接写磁盘（本机部署即本机磁盘），选一次就完成多集。

**操作流程**：
1. 点列表区的「批量下载」按钮进入多选模式（卡片左上出现复选框）
2. 点卡片勾选，或用「全选 / 清空」
3. 选「每部下集数」（全部 / 仅第 1 集 / 前 3、5、10 集）—— 剧集默认下全部会占很多空间
4. 点「下载所选 (N)」，自动打开下载中心看进度

**下载中心**（header 的图层图标或批量下载后自动弹出）：
- 按批次分组，显示「完成 X/Y」进度条与累计体积
- 逐集列出状态（下载中带百分比 / 排队中 / 已完成 / 失败），可单集取消
- 可删除整个批次、清除已完成记录

**服务端下载能力**：
- master 播放列表递归选档（取最高码率），media 列表取分片
- AES-128-CBC 解密（HLS 标准，IV 缺省时用媒体序列号大端 16 字节）
- TS 直接顺序拼接，或经 mux.js 转封装为 fMP4（与浏览器端产物一致，moov 时长已回填为真实值）
- 分片并发下载（默认 8）+ 4xx 视为确定性缺失不重试
- 先写 `.part` 临时文件，成功后 rename —— 中断不留「看着完整其实缺片」的文件
- 磁盘剩余空间低于 1GB 时拒绝开新任务

**实测（2026-10-21）**：

| 场景 | 结果 |
|---|---|
| 提交 3 集（2 部影片） | 126 秒，3/3 成功，190MB 落盘 |
| 提交 100 部 × 1 集 | 展开耗时 <10 秒，队列正常调度 |
| 5 部并发下载 | 4/5 完成，无失败 |
| 产物校验 | ftyp+moov+moof/mdat 结构完整，时长回填正确（48.8 / 91.3 分钟） |

**新增文件**：
- `src/lib/server-download.ts` — 服务端下载引擎（解析 / 解密 / 转封装 / 写盘）
- `src/lib/download-queue.ts` — 任务队列（批次 → 任务，状态落盘 `.queue.json`）
- `src/lib/download-config.ts` — 下载配置与磁盘空间检查
- `src/app/api/download/batch/route.ts` — 批量提交（服务端取详情展开成剧集）
- `src/app/api/download/queue/route.ts` — 队列查询
- `src/components/use-batch-download.ts` — 多选状态与提交逻辑（两处共用）
- `src/components/batch-download-bar.tsx` — 多选操作条
- `src/components/server-download-center.tsx` — 下载中心面板

## 九、注意事项

1. **纯 HTTP 部署**：局域网 IP 访问时必须保持 `COOKIE_SECURE=false`，否则浏览器会丢弃会话 Cookie，表现为「密码正确但一直掉线」。
2. **正式对外服务需 HTTPS**：用 Nginx / Caddy / Traefik 反代，并正确透传 `x-forwarded-proto`。
3. **预置源已配好**：31 个点播源（27 常规 + 4 成人）+ 1 个直播源已写入 `.env`，开箱即可搜索。也可在设置 → 源管理里自行增删。
4. **成人内容过滤已默认关闭**（`DEFAULT_ADULT_FILTER=false`），本机自用不做过滤。**若要把这个部署分享出去，请先把它改回 `true` 并重启**——该部署未配置 HTTPS，且默认无访问密码保护以外的防护。
5. **本机未安装 Docker**，故走源码部署；如需 Docker 方式：`docker compose up -d --build`。
6. 依赖安装时 npm 报告 19 个依赖漏洞（6 moderate / 11 high / 2 critical），来自上游包，未做 `audit fix --force`（会引入破坏性升级）。
7. **批量下载会占磁盘**：单集可达数 GB（实测「红海行动」139 分钟 / 2490 分片 / 2.5GB）。批量前先看「每部下集数」，剧集默认下全部很占空间。剩余空间低于 1GB 会自动拒绝开新任务。
8. **下载任务在服务端跑**：关掉浏览器不影响下载继续；但重启服务会中断进行中的任务（分片不缓存，重启后需重新提交）。
9. **「开启」必须从外部发起**：服务停了就没有进程能响应「启动」请求，所以站内页面的「开启服务」按钮在服务停止时不可用（会明确提示改用 `启动系统.bat`）。这是自托管服务的固有约束。
10. **客户端的浏览器 profile 在系统临时目录**（`%TEMP%\libretv-client-profile`），退出时自动清理。它与日常浏览器完全隔离，不会污染你的浏览记录与登录态。
11. **客户端需要 Node.js 18+**（它用 Node 起本地面板服务），并需要系统装有 Edge / Chrome / Brave 其中之一作为窗口宿主。
12. **开机自启用的是启动文件夹快捷方式**（`%APPDATA%\...\Programs\Startup\LibreTV.cmd`），不是注册表 Run 键——注册表方式在受限环境下会被安全策略拦下。取消自启直接删那个 `.cmd` 即可，或跑 `node scripts/ctl.mjs uninstall`。

## 十、客户端的 /app 前缀（导航问题的由来）

桌面客户端把 LibreTV 挂在面板的 `/app/` 前缀下：

| 地址 | 内容 |
|---|---|
| `http://localhost:9099/` | 控制面板（启停、状态、日志） |
| `http://localhost:9099/app/` | **LibreTV 首页** |
| `http://localhost:9099/app/watch?...` | 播放页 |

因此页面里的站内链接必须带上 `/app` 前缀，否则 `<Link href="/">` 会跳到
**控制面板首页**——用户点「回首页」看到页面完全没变，表现为「按钮没反应」。

实现见 `src/lib/base-path.ts`：

- `detectBasePath(pathname)`：从当前 pathname 判断是否运行在客户端（`/app` 前缀）；
- `withBasePath(path, basePath)`：给站内路径补前缀（已是绝对地址或已带前缀的原样返回）；
- 直连 8080 部署时基路径为空串，**行为与从前完全一致**（零行为变化）。

已适配的位置：header（Logo / 直播 / 系统 / 隐私 / 关于 / 搜索跳转）、
播放页（主页按钮 / 返回按钮 / 错误态返回首页）、隐私页、错误页、
首页搜索跳转、直播页切频道、详情弹窗与换源弹窗的播放链接、观看历史面板。

### 端到端验证

```bash
node scripts/ctl.mjs start --no-open --no-build   # 主服务 8080
node client/panel-server.mjs --port 9098          # 面板 9098

npm run test:e2e:client   # 客户端场景 12 项
npm run test:e2e:direct   # 直连场景 5 项
```

详见 `tests/README.md`。

## 十一、资源源扩充（2026-10-21）

### 点播源：31 → 38

从 `jcy012/LunaTV-config`（每日自动检测 API 状态的 80 站清单）逐个实测后新增 7 个：

| 名称 | 命中「战狼」 | 备注 |
|---|---|---|
| 非凡影视(主站) | 8 | |
| 鲸影 | 18 | |
| 鲸云(独家) | 18 | |
| 虎牙(全格式) | 18 | |
| 小鸡资源(成人) | 6 | `isAdult` |
| 美少女(成人) | 5 | `isAdult` |
| jkun资源(成人) | 9 | `isAdult`，仅经代理可达 |

**实测数据说明**：80 个候选中，直连可用 22 个、仅经代理可用 1 个，其余 57 个是真失效。
判别方法——对 32 个 `ECONNRESET`/超时类再用 HTTP 代理复测一遍，仍失败者判定为源站本身已挂，
不是本地网络问题。加源前都过这道筛，避免加一堆点不开的源。

### 直播源：515 → 1999（内置清单）

| 来源 | 频道数 | 说明 |
|---|---|---|
| 综合直播（远程） | 514 | 原有，实测 2026-10-21 正常 |
| 内置IPTV | 1999 | `public/iptv.m3u`，来自 niubihu1/tvbox 公开清单 |

分组：央视频道 / 卫视频道 / 地方综合 / 纪录纪实 / 音乐广播 / 经典电影 / 少儿动画 /
体育竞技 / 港澳台专区 / 电视剧场 / 4K·8K专区。

抽样实测 90 个频道（各分组均匀取样），**69% 可正常拉流**，各分组均有存活线路。
未逐条体检全部 1999 个（耗时过长），进「直播 → 一键检测」可按需清理失效台。

### `local:` 内置清单机制

直播源原本只接受 http(s) 绝对地址，但公开 IPTV 仓库（GitHub raw 等）在部分网络下
不可达，而本机托管是唯一稳定的选择。又不能填 `http://127.0.0.1:8080/...`——SSRF 会拦本机地址。

因此约定 `url` 可写 `local:iptv.m3u`：`/api/live/playlist` 识别该前缀后直接读
`public/` 下同名文件，**不走网络、不经 SSRF**。文件名用 `/^[\w.-]+\.m3u$/i` 校验，
杜绝 `../` 路径穿越。

新增文件时请自行把清单放进 `public/`：

```bash
# 清单放这里
public/iptv.m3u

# 在 .env 里引用
DEFAULT_LIVE_SOURCES=[{"name":"我的IPTV","url":"local:iptv.m3u"}]
```

### 顺带修掉的真实缺陷：搜索并发把弱源连累

**现象**：预置源到 38 个后，新加的两个源**单源测试完全正常**（HTTP 200、18 条），
但全源搜索时稳定 `fetch failed`。

**根因**：`/api/search` 用 `Promise.all(sources.map(searchSource))`——**38 个源同时**发起
请求，耗尽本机并发连接与文件描述符，弱源被同批其他源连累。

**修复**：新增 `src/lib/concurrent-map.ts` 的 `mapWithConcurrency`，按批（默认 6）顺序执行。
两个坏掉的源立刻恢复正常（18 条 / 9 条），全源搜索失败数从 6 降到 4（剩余 4 个是源站自身问题）。

可用 `SEARCH_MAX_CONCURRENCY` 调批大小（1–20，默认 6）。

**流式搜索实测**（前端真实路径，38 源搜「流浪地球」）：

- 首个结果出现：**166ms**
- 全部完成：16.6s，逐源推送 38 次

即用户几乎立刻看到第一批结果，不用等全部源跑完。

### 关于夸克/迅雷这类网盘资源

**实测结论：这条路在 LibreTV 里走不通，原因有三。**

1. **格式不对**：网盘资源给的是「分享链接 + 提取码」，不是 m3u8 直链，无法在网页里播放。
2. **免费接口已消失**：实测 7 个公开网盘搜索接口（酷乐聚合、iDataRiver、PanSou 及其各镜像），
   全部 502 / 接口下架 / 域名注销。近年网盘厂商风控关闭了这类服务，公开可用的免费实例几乎没有了。
3. **书源生态不兼容**：Legado 阅读的书源（`shareRssSource.json` 那类）用的是
   `ruleArticles` / `ruleContent` 这套**小说解析规则**，与 Apple CMS 的
   `list` / `vod_play_url` 完全不同协议，LibreTV 无法解析。

若确实需要网盘资源，可行的方向是自己搭一个网盘搜索服务（`yz_pansearch_api` 之类），
然后在 LibreTV 里新增一个「网盘资源」板块，把搜到的链接 + 提取码列出来供复制——
但那是**分享链接浏览器**，不是播放器。

### 明文 IPTV 的隐私说明

内置清单里约 87% 的直播线路是明文 HTTP（IPTV 生态本身不加密）。

这与点播侧的 `PRIVACY_REQUIRE_HTTPS` 冲突，因此加了**精确到场景**的豁免：
`PRIVACY_ALLOW_PLAINTEXT_IPTV`（默认开启，只作用于直播）。

理由：直播 URL 里不含任何个人语义（没有搜索词、没有片名，只有频道编号），
运营商看到 `http://120.76.248.139/live/bfgd/4200000488.m3u8` 并不知道你在看什么；
而且不加豁免的话，加进来的直播源会有 87% 被自己的防护拦掉。

**没有放宽全局规则**——`PRIVACY_REQUIRE_HTTPS` 对点播侧的保护完全不受影响（有测试守着）。

想要更强的匿名性，正确做法是配 `UPSTREAM_PROXY`：直播流也会经隧道出去，
运营商只看到「你连了代理节点」。

## 十二、已验证项

**基础链路**

- `/api/status` 返回 `version: 2.19.7`、`passwordRequired: true`、`defaultSources: 31`、`defaultLiveSources: 1`
- 首页 / `/live` / `/watch` / `/manifest.webmanifest` 均 200
- 登录鉴权：错误密码 → 401；正确密码 → 下发 `ltv_session` cookie；会话校验 → `verified: true`
- 豆瓣推荐 `/api/douban` 正常返回条目
- 热榜 `/api/hot-list?id=douban_movie_weekly`、`douban_tv_chinese` 正常
- 采集源连通性 `/api/source/test` 正常返回

**源可用性（2026-10-21 实测）**

- 31 个预置源聚合搜索：「战狼」284 条 / 3068ms、「庆余年」138 条 / 1344ms、「三体」154 条 / 2121ms，**全部源命中、0 失败**
- 详情链路：搜索 → 详情 → m3u8 直链可访问（`#EXTM3U` 校验通过）
- 直播源：`/api/live/playlist` 返回 510 个频道（CCTV1-5 等）

**热门剧集（2026-10-21 实测）**

- 首屏：31 源 / 0 失败 / 8.1 秒，唯一片名 569（浅取）
- 后台递进深翻：569 → 2288 → **5000** 唯一片名（约 40 秒完成两档）
- 分类切换 / 地区切换：20-110ms（走原始数据缓存）
- 地区分布（预热后）：国产 2215、欧美 456、日本 207、泰国 77、韩国 66、台湾 53、英国 48、香港 25
- 「剧集 + 欧美」直接列出 HBO 系剧集：中央情报局第二季、旺达在哪里第二季、流人第六季、法警小队第二季、火线家族、动物管制官第五季（均 25-27 个源收录）
- 详情 → m3u8 直链可访问

**直播体检（2026-10-21 实测，510 个频道）**

- 快速模式：27 秒，可达 455/510；优化前为 57 秒（同 host 限流放宽 + 批并发提升）
- 精确模式：101 秒，可播 442/510，分片级 395、限速 15
- 模式差异：快速误判 8 个可播源为死；精确多找出 21 个真死台
- 批并发 2 时 8.3 秒完成（命中服务端 30 分钟缓存）；首次全新检测 27 秒
- 单元测试 528 个全通过；`npm run lint` 无告警；`npm run typecheck` 通过

**成人内容链路（2026-10-21 实测）**

- `/api/status` 返回 `defaultAdultFilter: false`、预置源 31 个（其中 4 个 `isAdult: true`）
- 过滤关闭时 4 个成人源均参与搜索：森林资源 100 条、森林资源(备) 100 条、艾旦影视 4 条、仓库资源 66 条
- 过滤开启时同一查询结果被削减（100 → 90 条），验证过滤链路真实生效
- 成人分类 tab 输出 96 部，详情可取 m3u8 且直链可访问（`#EXTM3U` 校验通过）

**一键多选下载（2026-10-21 实测）**

- 热门剧集区与搜索结果区的「批量下载」按钮、多选模式、复选框、每部下集数下拉均正常渲染与交互（Playwright 实测）
- 勾选 → 全选 → 选集数 → 提交 → 下载中心自动打开，提示「已加入下载队列：100 集」
- 服务端实测：3 集（2 部影片）126 秒完成 / 3 成功 0 失败 / 190MB 落盘
- 产物校验：ftyp + moov + (moof+mdat)×N 结构完整；mvhd/tkhd 时长回填为真实值（48.8 / 91.3 分钟），非哨兵值
- 并发压力：5 部影片同时下载，4/5 完成无失败
- 队列取消：删除批次可中止 97 个排队任务
- 单元测试 548 个全通过；`npm run lint` 无告警；`npm run typecheck` 通过

**一键启停系统（2026-10-21 实测）**

- `scripts/ctl.mjs` 全部子命令可用：start / stop / restart / status / install / uninstall / logs / verify / delayed
- `status` 双路识别生效：PID 文件丢失时退到端口探测，仍能正确报告「运行中 · PID 61896 · 端口 8080」
- `stop` 按进程树终止（Windows `taskkill /T`），端口完全释放、status 变为「未运行」——不留孤儿进程
- 开机自启：写入启动文件夹 `LibreTV.cmd`，`install` → `status` 显示「已启用」→ `uninstall` 还原
- 站内「系统控制」页（`/system`）：状态卡片（端口 / PID / 已运行 / Node / 平台 / 开机自启 / 部署目录）、
  开启 / 关闭 / 重启三个按钮、header「系统」入口——Playwright 实测全部渲染正确，运行时「开启」按钮正确置灰
- **「关闭服务」按钮真实生效**：点击后出现「正在关闭」提示，约 2 秒后服务停止、端口释放、页面状态转为「已停止」
- 「关闭」的实现是派生独立进程延迟 2 秒执行 stop（服务无法直接关闭自己——请求还在处理中）
- 启动脚本带**存活自检 + 自动降级**：detached 启动后由独立进程复检，发现被环境回收则自动转前台模式
- 单元测试 548 个全通过；`npm run lint` 无告警；`npm run typecheck` 通过

**桌面客户端（2026-10-21 实测）**

- `打开客户端.bat` 双击后拉起独立窗口（浏览器 app 模式，无地址栏），面板页 200
- 控制面板元素齐全：状态标题、访问地址、端口、进程 PID、已运行时长、识别方式，
  以及开启 / 关闭 / 重启 / 用浏览器打开 / 进入系统 五个按钮
- **状态准确性**：服务运行时显示「服务运行中 · PID 47840 · 端口 8080 · 已运行 47 分 54 秒」，
  停止后字段清空、灰点、「点击开启服务启动」提示
- **「关闭服务」真实生效**：点击后约 2 秒服务停止、端口释放、面板转「服务已停止」，
  「开启服务」按钮恢复可用
- **「开启服务」真实生效**：服务未运行 → 点开启 → 服务启动（PID 29548）→ 首页 200 → 代理 200
- **「进入系统」可用**：同源导航到 `/app/`，LibreTV 页面完整渲染（标题、搜索框、热门剧集区）
- **客户端内搜索正常**：搜索「战狼」→ 62 部影片 / 379 条结果 / 60 张卡片
- **登录与鉴权正常**：客户端内登录后 `verified: true`，Cookie 正常随请求发送
- 代理转发覆盖页面路由（`/live`、`/system`、`/about`）、静态资源（`/_next/*`、`/icons/*`）、
  API（`/api/*`）与页面路由转发
- 端口占用处理：已有实例时复用其窗口；被其它程序占用时自动改用后续端口
