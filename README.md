# LibreTV 个人定制版

基于 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) **v2.19.7** 的个人自用修改版。
原项目使用 AGPL-3.0 许可证，本仓库遵循同一许可（见 [LICENSE](LICENSE)）。

技术栈：Next.js 15（App Router）+ TypeScript + Tailwind CSS，播放内核 ArtPlayer + hls.js。

---

## 与原版的差异

### 漫画模块
- **双源**：MangaDex（国际，支持分类/标签/地区筛选）+ 再漫画（中文，默认源）
- **分级筛选**：安全 / 建议 / 限制三档，按评级向下累积；`BLOCKED_TAGS` 在服务端硬排除
- **本地漫画库**：扫描目录、`zip`、`cbz`、`tar.gz`，支持嵌套包与 GNU 长路径；
  按体积分流（小包内存、大包流式索引），页序按自然排序重排

### 评分补全
- **双源**：TMDB（需免费 API key）+ 豆瓣（免 key，反爬严格）
- 标题清洗与相似度匹配，宁缺毋滥——低于阈值宁可不给分
- 按源限流与指数退避；缓存键 HMAC 派生，**磁盘不留明文片名**

### 访问与部署
- **局域网访问**：`LAN_ACCESS=1` 一键开放，自动枚举网卡并给出可访问地址；
  站内 `/system` 页可视化管理，弱密码会告警
- **Windows**：`启动系统.bat` / `停止系统.bat` / `查看状态.bat`（底层 `scripts/ctl.mjs`）
- **Docker**：两阶段构建 + standalone 输出
- **安卓手机（Termux）**：电脑构建、手机只跑，详见 [ANDROID.md](ANDROID.md)

### 隐私
- 播放走**同源代理** `/api/proxy`，上游只看到本机（或代理）
- 敏感参数放 URL **片段**（`#`），不出现在服务器日志与 Referer
- 本地加密与 HMAC 盲索引，密钥只在内存；可选 DoH 解析

### 其他
- **导航**：自维护会话栈，修复桌面客户端 `/app` 前缀丢失与「返回上一级」
- **内容筛选**：成人词表硬过滤 + 评分门槛（唯一词表来源 `src/lib/adult-keywords.ts`）
- **服务端批量下载**：选最高码率、AES-128 解密、fMP4 转封装、队列与断点
- **直播测活**：入口 / master / 分片四级递进探测，短缓存

---

## 快速开始

```bash
git clone https://github.com/hverlott/libretv.git
cd libretv
npm install
cp .env.example .env     # 至少填 PASSWORD
npm run dev              # 开发模式，默认 http://localhost:8080
```

生产模式：

```bash
npm run build
npm start
```

Windows 下也可直接双击 `启动系统.bat`（会自动构建并托管后台）。

---

## 关键配置

`.env` 里最常改的几项（完整说明见 `.env.example`）：

| 变量 | 说明 |
|---|---|
| `PASSWORD` | 访问密码，**必填**。局域网开放时它是唯一防线，请用 8 位以上 |
| `PORT` | 监听端口，默认 `8080` |
| `LAN_ACCESS` | `1` 允许局域网设备访问；默认仅本机 |
| `BIND_HOST` | 直接指定绑定地址，优先级高于 `LAN_ACCESS` |
| `TMDB_API_KEY` | 可选。填了走 TMDB 补全评分（50 次/秒）；不填降级到豆瓣 |
| `RATING_PROVIDER` | `auto` / `tmdb` / `douban` / `none` |
| `LOCAL_MANGA_DIR` | 本地漫画库根目录，留空则不启用 |

---

## 部署方式对比

| 方式 | 适用 | 说明 |
|---|---|---|
| Windows 本机 | 台式机 / 笔记本 | 双击 `.bat`，最省事 |
| Docker | NAS / 迷你主机 / 软路由 | 镜像约 200MB，零原生模块，ARM 直跑 |
| 安卓手机（Termux） | 闲置手机当 24h 服务器 | 免刷机免 root，功耗约 1W |

安卓方案的关键点：**电脑构建、手机只跑**（Termux 是 bionic libc，装不了 Next 的 SWC）。
`npm run build:standalone && npm run pack:standalone && npm run deploy:android` 全自动推送。

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

商业使用前请自行阅读 AGPL-3.0 全文并评估合规风险。项目仅供个人学习与自用。
