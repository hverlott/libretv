/**
 * 站内链接的基路径（base path）处理。
 *
 * ## 为什么需要
 *
 * 桌面客户端（client/panel-server.mjs）把 LibreTV 挂在面板的 `/app/` 前缀下：
 * 面板自己的首页是 `/`（控制面板），LibreTV 的首页是 `/app/`。
 *
 * 于是页面里写死的 `<Link href="/">` 在客户端中会导航到
 * `http://localhost:9099/` —— 那是**控制面板**，不是 LibreTV 首页。
 * 用户点「回首页」看到页面毫无变化，表现为「按钮没反应」。
 *
 * 同样的问题影响所有站内链接：/live、/system、/privacy、/about、/watch。
 * 面板虽然对这些路径做了转发白名单，但转发时**剥掉了 /app 前缀**，
 * 于是 LibreTV 收到的 URL 与当前页面不同步，客户端路由状态错乱。
 *
 * ## 方案
 *
 * 运行时探测基路径并统一拼接：
 * - 直连 8080 → 基路径为空，所有链接与原来完全一致（零行为变化）；
 * - 客户端 9099 → 基路径为 `/app`，所有站内链接自动带上前缀。
 *
 * 探测方式：看当前 pathname 是否以 `/app` 开头。
 * 客户端的反向代理会把 `/app/watch` 映射到服务的 `/watch`，
 * 但**浏览器侧的地址栏**始终是 `/app/watch`，因此 pathname 判定可靠。
 */

/** 客户端基路径前缀 */
export const CLIENT_BASE = '/app';

/**
 * 从当前 pathname 推断基路径。
 *
 * - pathname 以 `/app` 开头（且 `/app` 后面是 `/` 或结尾）→ 基路径为 `/app`
 * - 否则 → 基路径为空字符串（直连部署）
 */
export function detectBasePath(pathname: string | null): string {
  if (!pathname) return '';
  if (pathname === CLIENT_BASE) return CLIENT_BASE;
  if (pathname.startsWith(`${CLIENT_BASE}/`)) return CLIENT_BASE;
  return '';
}

/**
 * 给站内路径补上基路径前缀。
 *
 * 已经是绝对路径（http://、//）或带基路径前缀的路径原样返回，
 * 避免重复拼接。
 */
export function withBasePath(path: string, basePath: string): string {
  if (!basePath) return path;
  if (!path.startsWith('/')) return path;
  // 外部绝对地址不动
  if (path.startsWith('//')) return path;
  // 已经带前缀的不重复加
  if (path === basePath || path.startsWith(`${basePath}/`)) return path;
  // 根路径拼出的是 basePath 本身（不带尾斜杠），与直连下的 "/" 语义一致
  if (path === '/') return basePath;
  return `${basePath}${path}`;
}

/**
 * 生成站点内导航用的完整 href。
 *
 * 用法（组件内）：
 * ```tsx
 * const pathname = usePathname();
 * const basePath = detectBasePath(pathname);
 * <Link href={withBasePath('/', basePath)}>回首页</Link>
 * ```
 */
export function siteHref(path: string, pathname: string | null): string {
  return withBasePath(path, detectBasePath(pathname));
}
