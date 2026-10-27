import type { NextConfig } from 'next';
import fs from 'node:fs';
import path from 'node:path';

/** 版本号以 package.json 为单一来源，构建时注入 process.env.APP_VERSION（/api/status 使用） */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 隐私保护响应头。
 *
 * 逐条说明为什么需要（都是「看过什么」或「访问了什么」的泄露通道）：
 *
 * - Referrer-Policy: no-referrer
 *   页面里的封面图若直连图床，Referer 会带上 /watch?title=战狼 这种地址，
 *   等于把「你在看哪部片子」直接告诉图床。全局禁用 Referer 断掉这条通道。
 * - X-Robots-Tag: noindex, nofollow
 *   防止被搜索引擎收录（部署到公网或局域网时可能发生）。
 * - X-Frame-Options: DENY + frame-ancestors 'none'
 *   禁止被任意站点 iframe 嵌入：嵌入后攻击者可做点击劫持，诱导你点「下载」等按钮。
 * - X-Content-Type-Options: nosniff
 *   禁止浏览器猜测响应类型，避免把图片当脚本执行。
 * - Cross-Origin-Opener-Policy / Cross-Origin-Resource-Policy
 *   隔离浏览上下文与资源缓存，避免其他站点通过 window.opener 读取本页内容。
 * - Permissions-Policy
 *   关闭本站用不到的敏感设备能力（摄像头、麦克风、定位、剪贴板读取）。
 * - Cache-Control: no-store（仅 API 路由）
 *   代理与详情响应包含片名与播放地址，不允许落进浏览器磁盘缓存或中间代理缓存。
 *
 * CSP 刻意不启用完整版：Next.js 运行时依赖内联脚本与 eval，
 * 收紧 CSP 会直接导致站点无法启动，对本地自用部署收益远小于风险。
 */
const securityHeaders = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), magnetometer=(), midi=(), interest-cohort=()',
  },
];

const nextConfig: NextConfig = {
  // standalone 输出仅供 Docker 镜像构建使用（DOCKER_BUILD=1）；
  // 本地 next start 在 standalone 模式下不受支持，故按环境切换
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  env: { APP_VERSION: readAppVersion() },
  // 采集站/豆瓣等上游地址在运行时由用户配置，构建期无法枚举，关闭图片优化改用 <img>
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // API 响应含片名与播放地址，禁止任何层级缓存
        source: '/api/:path*',
        headers: [
          ...securityHeaders,
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
    ];
  },
};

export default nextConfig;
