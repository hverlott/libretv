# 端到端测试（真实浏览器）

这些脚本用 Playwright 驱动**系统 Edge**（不下载 Chromium），验证真实交互路径。

## 前置条件

两个服务都要在跑：

```bash
# 1) LibreTV 主服务（8080）
node scripts/ctl.mjs start --no-open --no-build

# 2) 桌面客户端面板（9098，测试用非默认端口避免与正式客户端冲突）
node client/panel-server.mjs --port 9098
```

## 运行

```bash
npm run test:e2e:client   # 客户端（/app/ 前缀）下的站内导航
npm run test:e2e:direct   # 直连 8080 场景的回归
npm run test:e2e:filter   # 设置里的内容筛选（全选 / 只看有评分）
```

环境变量：`PANEL_URL`（默认 `http://127.0.0.1:9098`）、`PASSWORD`（默认 `libretv`）、
`BASE_URL`（默认 `http://127.0.0.1:8080`）。

## 覆盖什么

### `e2e-client-nav.cjs`（客户端）

回归的是「播放页点主页按钮没反应」这个 bug：

客户端把 LibreTV 挂在 `/app/` 前缀下（面板自己的首页是 `/`），
页面里写死的 `href="/"` 会跳到控制面板——页面变了但不是 LibreTV，用户看着就像"没反应"。

断言：

- 播放页「主页」按钮的 `href` 是 `/app`（不是 `/`）；
- 点击后停在 `/app` 下，落地页是 LibreTV 首页（含搜索框）而非控制面板；
- header 的 Logo 与「直播」链接带 `/app` 前缀；
- 首页搜索跳转留在 `/app` 下。

### `e2e-direct-nav.cjs`（直连）

确认直连部署**没有回归**：所有链接保持根路径（`/`、`/live`），
播放页主页按钮点击后回到 `http://127.0.0.1:8080/`。

### `e2e-content-filter.cjs`（内容筛选）

验证设置里的「内容筛选」：

- 设置面板（一级「偏好设置」→ 二级「首页与内容」）里出现筛选控件；
- 默认「全选」时不显示评分门槛滑块，切到「只看有评分」后出现；
- 设置被持久化到 localStorage；
- 百度热播剧（**无评分**）在「只看有评分」下被整体隐藏；
- 有豆瓣评分的电影周榜在 ≥6 分时保留，门槛提到 9 分后被进一步筛减；
- 可切回「全选」。

## 踩过的坑（写测试时注意）

- **登录弹窗是异步挂载的**：必须 `waitFor({state:'visible'})` 等它出现，
  先 `count()` 再判断会漏掉它（count 此刻是 0，但弹窗随后才挂载）。
- **影片卡片不是 `<a>` 链接**：搜索结果的卡片是 `onClick` 触发详情弹窗，
  用 `a[href*="watch"]` 选不到；标题元素带 `title` 属性可用来定位。
- **播放页没有站点 Header 组件**：它有自己的精简 header，
  测 header 导航要去 `/app/live`（或首页）。
