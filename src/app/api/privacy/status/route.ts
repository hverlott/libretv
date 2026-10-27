import { NextResponse } from 'next/server';
import { sessionFromCookieHeader, isPasswordConfigured } from '@/lib/auth';
import { getProxyStatus } from '@/lib/outbound-proxy';
import { isDohHealthy, isDohOnly, isDohResolveEnabled } from '@/lib/doh';
import { isHttpsRequired } from '@/lib/privacy-https';
import { ratingStatus } from '@/lib/rating';

export const runtime = 'nodejs';

/**
 * 隐私状态总览：供 /privacy 页面展示「当前哪些防护是开着的」。
 *
 * 只暴露状态与配置摘要，**不泄露任何凭据**：
 * - 代理地址脱敏（不含用户名密码）；
 * - 不返回任何密钥材料。
 *
 * 「运营商可见性」是本接口的重点：把「ISP 能看到什么」拆成可核查的几项，
 * 而不是笼统地说「已加密」。每一项都对应一个可验证的技术事实。
 */
export async function GET(req: Request) {
  const verified = isPasswordConfigured() && sessionFromCookieHeader(req.headers.get('cookie'));
  const proxy = getProxyStatus();

  // —— 运营商（ISP）能看到什么 ——
  // 逐项判断，逻辑与实际实现一一对应：
  // 1. 搜索词：明文 HTTP 上游会把 ?wd=xxx 直接暴露给运营商
  const httpsRequired = isHttpsRequired();
  // 2. DNS 查询：域名解析请求会到达运营商的 DNS 服务器
  const dnsProtected = proxy.enabled ? (proxy.dnsProtected ?? false) : isDohResolveEnabled() && isDohHealthy();
  // 3. 内容与目标域名：有加密代理时运营商只看到「你连了某个 IP」
  const contentProtected = proxy.enabled && (proxy.encrypted ?? false);
  // 4. 流量特征：即使全加密，运营商仍能看到「你在传输大量数据」

  return NextResponse.json(
    {
      // 鉴权状态
      passwordConfigured: isPasswordConfigured(),
      verified,

      // 出站代理
      proxy: {
        enabled: proxy.enabled,
        kind: proxy.kind,
        endpoint: proxy.endpoint ?? null,
        // DNS 查询是否由代理端完成（= 运营商看不到你查了什么域名）
        dnsProtected: proxy.dnsProtected ?? false,
        // 代理链路是否加密（= 运营商看不到目标域名与内容）
        encrypted: proxy.encrypted ?? false,
        error: proxy.error ?? null,
      },

      // 本地加密
      encryption: {
        available: isPasswordConfigured(),
        // 密钥在客户端内存中持有，服务端不保存
        note: isPasswordConfigured()
          ? '观看历史与搜索历史以 AES-256-GCM 加密落盘，密钥仅在浏览器内存中持有'
          : '未配置访问密码，本地加密不可用',
      },

      // 传输与访问
      transport: {
        // 同源代理：播放与下载全部经本站代理，浏览器不直连上游
        sameOriginPlayback: true,
        referrerPolicy: 'no-referrer',
        bindHost: process.env.BIND_HOST || '127.0.0.1',
      },

      /**
       * 运营商可见性：逐项说明 ISP 能看到什么。
       * 前三项可被配置消除，第四项（流量特征）在技术上无法消除。
       */
      isp: {
        /** 是否强制 HTTPS 上游（否则搜索词明文可见） */
        httpsRequired,
        /** DNS 查询是否受保护（否则运营商知道你在查哪些采集站域名） */
        dnsProtected,
        /** 内容与目标域名是否受保护（否则运营商知道你在连哪个源、传什么） */
        contentProtected,
        /** DoH 是否启用（供 UI 说明当前用的是哪种保护） */
        dohEnabled: isDohResolveEnabled(),
        /** DoH 当前是否健康（不可用时会回落到系统 DNS，如实告知） */
        dohHealthy: isDohHealthy(),
        /** 是否禁止回落到系统 DNS（宁可失败也不泄漏查询） */
        dohOnly: isDohOnly(),
      },

      // 评分补全：全站唯一会主动把片名交给第三方的功能，
      // 在隐私页单列，让用户能直接看到它开着、正在用哪个提供方
      rating: (() => {
        const r = ratingStatus();
        return {
          enabled: r.enabled,
          providers: r.providers,
          tmdbConfigured: r.tmdbConfigured,
          doubanEnabled: r.doubanEnabled,
          cacheSize: r.cacheSize,
          cooling: r.cooling,
        };
      })(),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
