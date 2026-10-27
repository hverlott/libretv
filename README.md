# LibreTV 个人定制版

**把闲置的安卓手机，变成一台 24 小时在线的私人影视库。**

不用开电脑、不用买 NAS、不用刷机 root。一台吃灰的安卓手机插上充电器，
局域网里的电脑、电视、平板、手机打开浏览器就能用。功耗约 1W，一年电费十几块。

> 基于 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) v2.19.7 的个人修改版，
> 按上游 **AGPL-3.0-or-later** 发布（见 [LICENSE](LICENSE)）。

---

## 为什么是闲置手机

| 方案 | 硬件成本 | 开机即用 | 功耗 | 主要麻烦 |
|---|---|---|---|---|
| **闲置安卓手机** | **¥0** | ✅ 常亮待机 | **~1W** | 免刷机免 root，有电池还能扛住断电 |
| 每次开电脑 | ¥0 | ❌ 要等开机 | 60–200W | 用完还得关，机器还吵 |
| NAS / 迷你主机 | ¥800 起 | ✅ | 20–40W | 要装系统、配 Docker、占地方 |
| 云服务器 | ¥60/月起 | ✅ | — | 看片走公网流量要花钱，一部 4K 几十块 |

实测数据（Android 14 + Termux）：

| 指标 | 实测值 |
|---|---|
| 内存占用 | **100–140 MB**（单进程，零原生模块） |
| 冷启动 | **340ms** |
| 局域网页面响应 | ~90ms |
| 局域网吞吐 | **37 Mbps**（1080p 无压力） |
| 部署体积 | 49 MB |

> 前提是**手机原本就闲置**。为这事专门买台机器，不如直接买千元档迷你主机。

---

## 手机部署：五步

```bash
# 1. 装 Termux（F-Droid / GitHub 版，别用 Play 商店那个已废弃的）
# 2. 装 Node（Termux 内）
pkg update && pkg install -y nodejs-lts
# 3. 电脑上打包 —— 不要在手机上构建，Termux 是 bionic libc，装不了 Next 的 SWC
npm run build:standalone && npm run pack:standalone
# 4. 推到手机（USB 调试 + run-as，全自动）
npm run deploy:android
# 5. 手机上启动（Termux 内）
lb          # 启动：崩溃自动重启 + 唤醒锁
lbr         # 改完配置后重启
lbclean     # 清理日志与评分缓存
```

完整步骤、ColorOS 系统设置、以及踩过的坑见 **[ANDROID.md](ANDROID.md)**。

---

## 与原版的差异

### 漫画模块
- **双源**：MangaDex（国际，分类/标签/地区筛选）+ 再漫画（中文，默认源）
- **分级筛选**：安全 / 建议 / 限制三档，按评级向下累积；`BLOCKED_TAGS` 服务端硬排除
- **本地漫画库**：目录、`zip`、`cbz`、`tar.gz`，支持嵌套包与 GNU 长路径；
  按体积分流（小包内存、大包流式索引），页序按自然排序重排

### 评分补全
- **双源**：TMDB（需免费 API key）+ 豆瓣（免 key，反爬严格）
- 标题清洗与相似度匹配，宁缺毋滥 —— 低于阈值宁可不给分
- 按源限流与指数退避；缓存键 HMAC 派生，**磁盘不留明文片名**

### 访问与部署
- **局域网访问**：`LAN_ACCESS=1` 一键开放，自动枚举网卡并给出可访问地址；
  站内 `/system` 页可视化管理，弱密码会告警
- **Windows**：`启动系统.bat` / `停止系统.bat` / `查看状态.bat`（底层 `scripts/ctl.mjs`）
- **Docker**：两阶段构建 + standalone 输出，镜像约 200MB
- **安卓（Termux）**：见上文，免刷机免 root

### 隐私
- 播放走**同源代理** `/api/proxy`，上游只看到本机（或代理）
- 敏感参数放 URL **片段**（`#`），不进服务器日志、不进 Referer
- 本地加密与 HMAC 盲索引，密钥只在内存；可选 DoH 解析

### 其他
- **导航**：自维护会话栈，修复桌面客户端 `/app` 前缀丢失与「返回上一级」
- **内容筛选**：成人词表硬过滤 + 评分门槛（唯一词表来源 `src/lib/adult-keywords.ts`）
- **服务端批量下载**：选最高码率、AES-128 解密、fMP4 转封装、队列与断点
- **直播测活**：入口 / master / 分片四级递进探测，短缓存

---

## 本地开发

```bash
npm install
cp .env.example .env     # 至少填 PASSWORD
npm run dev              # http://localhost:8080
```

生产模式：`npm run build && npm start`

---

## 关键配置

`.env` 里最常改的几项（完整说明见 `.env.example`）：

| 变量 | 说明 |
|---|---|
| `PASSWORD` | 访问密码，**必填**。局域网开放时它是唯一防线，8 位以上 |
| `PORT` | 监听端口，默认 `8080` |
| `LAN_ACCESS` | `1` 允许局域网设备访问；默认仅本机 |
| `BIND_HOST` | 直接指定绑定地址，优先级高于 `LAN_ACCESS` |
| `TMDB_API_KEY` | 可选。填了走 TMDB 补全评分（50 次/秒）；不填降级到豆瓣 |
| `RATING_PROVIDER` | `auto` / `tmdb` / `douban` / `none` |
| `LOCAL_MANGA_DIR` | 本地漫画库根目录，留空则不启用 |

---

## 测试

```bash
npm test                 # 单元测试
npm run test:e2e:rating  # 评分接口端到端
npm run test:e2e:lan     # 局域网访问端到端
```

端到端测试用 Playwright（`channel: 'msedge'`），需要本机有 Edge。

---

## 许可与归属

本项目是 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 的**修改版本**，
按上游的 **AGPL-3.0-or-later** 发布，完整许可证见 [LICENSE](LICENSE)。

- 原始版权归 LibreTV 原作者所有
- 本仓库的修改部分同样以 AGPL-3.0 授权
- 按 AGPL 第 13 条：若通过计算机网络向他人提供服务，应向其提供对应的完整源代码

仅供个人学习与自用。商业使用前请自行阅读 AGPL-3.0 全文。
