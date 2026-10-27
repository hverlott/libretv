'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { useToast } from '@/components/toast';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { api } from '@/lib/client-api';
import { clearAllLocalTraces } from '@/lib/db';
import { usePrivacyKey } from '@/components/privacy-key-provider';
import { cn } from '@/lib/utils';
import { detectBasePath, withBasePath } from '@/lib/base-path';
import type { PrivacyStatusResponse } from '@/lib/types';

/**
 * 隐私中心：把「当前有哪些防护是开着的」摊开给用户看。
 *
 * 设计原则：不做黑箱。每一项防护都说明它防的是哪条泄露路径，
 * 以及没开启时具体会暴露什么——用户据此判断是否需要调整，
 * 而不是被动地相信一个「已保护」的标签。
 */
export default function PrivacyPage() {
  const { toast } = useToast();
  const { ready: keyReady, reason: keyReason } = usePrivacyKey();
  // 客户端（/app/ 前缀）下站内链接需带前缀
  const basePath = detectBasePath(usePathname());
  const [status, setStatus] = useState<PrivacyStatusResponse | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.privacyStatus());
    } catch {
      // 未登录时接口可能受限：状态区显示为未知，不阻塞页面其它部分
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleClear = useCallback(async () => {
    setClearing(true);
    try {
      const result = await clearAllLocalTraces();
      toast(`已清除：${result.cleared.join('、')}`, 'success');
      setConfirmClear(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : '清除失败', 'error');
    } finally {
      setClearing(false);
    }
  }, [toast]);

  const proxyOn = status?.proxy.enabled ?? false;
  const localOnly = (status?.transport.bindHost ?? '127.0.0.1') === '127.0.0.1';
  const isp = status?.isp;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1 w-full max-w-4xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-content">隐私中心</h1>
          <p className="text-sm text-muted mt-1">
            LibreTV 自用部署不会主动上传你的观看记录，但「看了什么」仍可能通过多条路径外泄。
            下面列出当前的防护状态与逐项说明。
          </p>
        </div>

        {/* —— 运营商视角：ISP 能看到什么 —— */}
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-content mb-1">网络运营商（ISP）能看到什么</h2>
          <p className="text-xs text-faint mb-2.5">
            运营商在链路上，比任何网站都靠前。逐项列出他们能获取的信息，以及当前是否受保护。
          </p>
          <div className="card p-4 space-y-3">
            <IspRow
              label="你的搜索词（如「战狼」）"
              detail="明文 HTTP 的采集站会把请求路径原样送过链路，运营商的 DPI 设备直接可见"
              protected={isp?.httpsRequired ?? true}
              protectedText="已强制 HTTPS：明文公网源会被直接拒绝"
              unprotectedText="未强制 HTTPS：明文源的搜索词对运营商可见"
            />
            <IspRow
              label="你查询的域名（DNS 请求）"
              detail="运营商的 DNS 服务器会记录你查过哪些采集站、哪些 CDN，按时间串起来就能还原"
              protected={isp?.dnsProtected ?? false}
              protectedText="已受保护：DNS 查询走加密通道，运营商看不到域名"
              unprotectedText="未受保护：运营商能看到你查了哪些域名"
            />
            <IspRow
              label="你在连哪个源、传输什么内容"
              detail="即使走 HTTPS，运营商也能看到连接的服务器 IP 与流量特征"
              protected={isp?.contentProtected ?? false}
              protectedText="已受保护：出站代理链路加密，运营商只看到你连了代理节点"
              unprotectedText="未受保护：运营商能看到你连接的服务器 IP 与传输量"
            />
            <IspRow
              label="流量特征（传输了多少数据、什么时段）"
              detail="视频流量与网页流量差异明显，运营商能推断出你在看视频"
              protected={false}
              protectedText=""
              unprotectedText="技术上无法消除：即使全链路加密，流量形状依然可辨"
              alwaysWarn
            />
          </div>
          {isp && !isp.dnsProtected && !proxyOn && (
            <p className="text-xs text-warning mt-2 leading-relaxed">
              提示：开启出站代理（<code className="text-faint">UPSTREAM_PROXY=socks5://127.0.0.1:9050</code>）
              可同时保护「DNS 查询」与「目标域名」两项；单独启用 DoH（<code className="text-faint">DOH_RESOLVE=1</code>）
              也能保护 DNS 查询。
            </p>
          )}
        </section>

        {/* —— 防护状态总览 —— */}
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-content mb-2.5">当前防护状态</h2>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <StatusCard
              ok={status?.transport.sameOriginPlayback ?? true}
              title="播放经同源代理"
              desc="浏览器不直连上游 CDN，源站看不到你的浏览器 IP"
            />
            <StatusCard
              ok={proxyOn}
              title="出站代理"
              desc={
                proxyOn
                  ? `已启用（${status?.proxy.endpoint}），源站看到的是代理 IP`
                  : '未启用：源站与 CDN 能看到你的真实 IP 与请求路径'
              }
              warn={!proxyOn}
            />
            <StatusCard
              ok={localOnly}
              title="仅本机可访问"
              desc={
                localOnly
                  ? '服务只监听 127.0.0.1，局域网内其他设备无法连接'
                  : `服务监听 ${status?.transport.bindHost}，同网段设备可访问`
              }
              warn={!localOnly}
            />
            <StatusCard
              ok={keyReady}
              title="本地历史加密"
              desc={
                keyReady
                  ? '观看历史与搜索历史以 AES-256-GCM 加密落盘'
                  : keyReason || '密钥未就绪'
              }
              warn={!keyReady}
            />
            <StatusCard
              ok={status?.rating.enabled ?? false}
              title="评分补全"
              desc={
                status?.rating.enabled
                  ? `已开启，经 ${status.rating.providers
                      .map((p) => (p === 'tmdb' ? 'TMDB' : '豆瓣'))
                      .join(' → ')} 查询片名（缓存 ${status.rating.cacheSize} 条）`
                  : '未开启：不向任何第三方发送片名'
              }
              // 开着不是错误，但确实是唯一对外发片名的路径，用告警色提示可关闭
              warn={status?.rating.enabled ?? false}
            />
          </div>
        </section>

        {/* —— 泄露路径逐条说明 —— */}
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-content mb-2.5">防护了什么</h2>
          <div className="card p-4 space-y-4">
            <PrivacyRow
              title="源站与 CDN 看不到你的真实 IP"
              detail="播放地址统一改写为本站 /api/proxy 同源形式，浏览器只与本机通信。再叠加出站代理后，连本机 IP 也不会暴露给上游。"
            />
            <PrivacyRow
              title="分片路径与片名不进上游日志"
              detail="上游的 m3u8 与分片请求都在服务端发起，路径里的片名、分辨率、时间戳不经过浏览器，也不会写进你的浏览器缓存。"
            />
            <PrivacyRow
              title="片名不进 URL、不进服务器日志"
              detail="片名与直链改放 URL 片段（#之后），不会发送给服务器，也不会出现在 Referer 头或反向代理的访问日志里。"
            />
            <PrivacyRow
              title="本地磁盘不留明文片名"
              detail="观看历史与搜索历史以 AES-256-GCM 加密后写入 IndexedDB；搜索历史主键改用带密钥的 HMAC 盲索引，无法通过字典攻击反查。"
            />
            <PrivacyRow
              title="不向第三方发送 Referer"
              detail="全局 Referrer-Policy: no-referrer，封面图直连图床时不会带上你的页面地址。"
            />
            <PrivacyRow
              title="不被任意网站当作开放代理"
              detail="代理端点的 CORS 收紧为仅同源，第三方网页无法借你的机器拉取任意资源。"
            />
            <PrivacyRow
              title="不被搜索引擎收录"
              detail="robots.txt 全站禁止抓取，并下发 X-Robots-Tag: noindex，避免片名被索引到公开搜索引擎。"
            />
          </div>
        </section>

        {/* —— 仍需你自行留意的部分 —— */}
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-content mb-2.5">仍需你留意的</h2>
          <div className="card p-4 space-y-3">
            <NoticeRow
              title="本机管理员与磁盘访问"
              detail="浏览器的解密密钥只在页面内存中，但已登录的会话仍可读出历史。共用电脑时建议用不同的系统账户，或用下面的「清除全部本地痕迹」。"
            />
            <NoticeRow
              title="浏览器自身的同步与历史"
              detail="浏览器的「历史记录同步」会把访问过的 URL 上传到你的浏览器账号。片名已移出 URL，但页面路径本身仍会被记录。"
            />
            <NoticeRow
              title="下载的文件名"
              detail="下载的影片以片名命名，文件明文躺在磁盘上。需要时可在下载后自行重命名。"
            />
            {status?.rating.enabled && (
              <NoticeRow
                title="评分补全会把片名交给第三方"
                detail={`你浏览的条目，其片名会被发给 ${status.rating.providers
                  .map((p) => (p === 'tmdb' ? 'TMDB' : '豆瓣'))
                  .join(' / ')} 换取评分。对方因此知道「某个 IP 查过这部片」。
                  这是全站唯一的对外片名路径，可在「设置 → 首页与内容过滤」里关掉「联网补全评分」，
                  或由部署者用 RATING_PROVIDER=none 彻底关闭。评分缓存落盘时只存 HMAC 键值，不含明文片名。`}
              />
            )}
          </div>
        </section>

        {/* —— 清理工具 —— */}
        <section>
          <h2 className="text-sm font-semibold text-content mb-2.5">本地数据</h2>
          <div className="card p-4">
            <p className="text-sm text-muted mb-3">
              一键清除本机保存的全部观看痕迹：观看历史与播放进度、搜索历史、下载任务记录、
              视频分片缓存、直播测活缓存。源配置与主题设置会保留。
            </p>
            <button
              type="button"
              className="btn bg-danger-solid text-white hover:opacity-90"
              disabled={clearing}
              onClick={() => setConfirmClear(true)}
            >
              {clearing ? '正在清除...' : '清除全部本地痕迹'}
            </button>
          </div>
        </section>

        <div className="mt-8 flex items-center gap-4 text-sm">
          <Link href={withBasePath('/', basePath)} className="text-accent hover:underline">
            返回首页
          </Link>
          <Link href={withBasePath('/about', basePath)} className="text-muted hover:underline">
            关于
          </Link>
        </div>
      </main>

      <SiteFooter />

      <ConfirmDialog
        open={confirmClear}
        title="清除全部本地痕迹？"
        message="观看历史、播放进度、搜索历史、下载任务记录与视频分片缓存都会被删除。此操作不可撤销，但不会影响你的源配置。"
        confirmLabel="确认清除"
        cancelLabel="取消"
        danger
        onConfirm={() => void handleClear()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}

/** 运营商可见性条目：说明「是什么 / 为什么会暴露 / 当前是否受保护」 */
function IspRow({
  label,
  detail,
  protected: isProtected,
  protectedText,
  unprotectedText,
  alwaysWarn,
}: {
  label: string;
  detail: string;
  protected: boolean;
  protectedText: string;
  unprotectedText: string;
  /** 技术上无法消除的项：始终用中性色提示，不给「开/关」二元感 */
  alwaysWarn?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <span
        className={cn(
          'shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold',
          isProtected ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
        )}
      >
        {isProtected ? '✓' : '!'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium text-content">{label}</span>
          <span className={cn('text-[11px]', isProtected ? 'text-success' : 'text-warning')}>
            {isProtected ? '已受保护' : alwaysWarn ? '无法消除' : '可见'}
          </span>
        </div>
        <p className="text-xs text-muted leading-relaxed mt-0.5">{detail}</p>
        <p className={cn('text-xs leading-relaxed mt-0.5', isProtected ? 'text-success' : 'text-warning')}>
          {isProtected ? protectedText : unprotectedText}
        </p>
      </div>
    </div>
  );
}

/** 状态卡片：绿=已开启，琥珀=需要注意 */
function StatusCard({
  ok,
  warn,
  title,
  desc,
}: {
  ok: boolean;
  warn?: boolean;
  title: string;
  desc: string;
}) {
  return (
    <div
      className={cn(
        'card p-3.5 border-l-2',
        ok ? 'border-l-success' : warn ? 'border-l-warning' : 'border-l-line'
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          className={cn(
            'inline-block w-2 h-2 rounded-full shrink-0',
            ok ? 'bg-success' : warn ? 'bg-warning' : 'bg-faint'
          )}
        />
        <span className="text-sm font-medium text-content">{title}</span>
        <span className={cn('ml-auto text-xs', ok ? 'text-success' : warn ? 'text-warning' : 'text-faint')}>
          {ok ? '已开启' : warn ? '需关注' : '未知'}
        </span>
      </div>
      <p className="text-xs text-muted leading-relaxed">{desc}</p>
    </div>
  );
}

/** 防护说明条目 */
function PrivacyRow({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-6 h-6 rounded-md bg-chip flex items-center justify-center">
        <span className="text-[10px] text-accent font-semibold">✓</span>
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-content">{title}</p>
        <p className="text-xs text-muted leading-relaxed mt-0.5">{detail}</p>
      </div>
    </div>
  );
}

/** 提示条目 */
function NoticeRow({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-6 h-6 rounded-md bg-chip flex items-center justify-center">
        <span className="text-[10px] text-warning font-semibold">!</span>
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-content">{title}</p>
        <p className="text-xs text-muted leading-relaxed mt-0.5">{detail}</p>
      </div>
    </div>
  );
}
