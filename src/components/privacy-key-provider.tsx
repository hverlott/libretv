'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { clearEncryptionKey, initEncryptionKey } from '@/lib/privacy-crypto';
import { useAuth } from './auth';

/**
 * 本地加密密钥的注入时机。
 *
 * 密钥由服务端派生，只在内存中持有（不写 localStorage / IndexedDB）：
 * - 页面加载时若已有有效会话（httpOnly cookie），立即取密钥；
 * - 未登录时等登录成功后再取（由 AuthProvider 的 verified 变化驱动）。
 *
 * 取不到密钥时（未配置 PASSWORD、服务端异常）不阻塞任何功能：
 * db 层会自动退回明文读写，保证站点仍可正常使用。
 */
interface PrivacyKeyContextValue {
  /** 密钥是否已就绪（本地历史已按加密方式落盘） */
  ready: boolean;
  /** 密钥不可用的原因（用于隐私中心展示） */
  reason: string | null;
}

const PrivacyKeyContext = createContext<PrivacyKeyContextValue>({
  ready: false,
  reason: null,
});

export function usePrivacyKey(): PrivacyKeyContextValue {
  return useContext(PrivacyKeyContext);
}

export function PrivacyKeyProvider({ children }: { children: ReactNode }) {
  const { verified, checked } = useAuth();
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    if (!checked) return;
    if (!verified) {
      // 退出登录：清掉内存中的密钥，避免登出后仍能读出历史
      clearEncryptionKey();
      setReady(false);
      return;
    }

    let cancelled = false;
    queryClient
      .fetchQuery({
        queryKey: ['privacy-key'],
        queryFn: () => api.privacyKey(),
        staleTime: 0,
        retry: false,
      })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.available || !res.key) {
          setReady(false);
          setReason('服务器未配置访问密码，密钥不可用');
          return;
        }
        await initEncryptionKey(res.key);
        if (cancelled) return;
        setReady(true);
        setReason(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReady(false);
        setReason(err instanceof Error ? err.message : '密钥获取失败');
      });

    return () => {
      cancelled = true;
    };
  }, [verified, checked, queryClient]);

  return (
    <PrivacyKeyContext.Provider value={{ ready, reason }}>
      {children}
    </PrivacyKeyContext.Provider>
  );
}
