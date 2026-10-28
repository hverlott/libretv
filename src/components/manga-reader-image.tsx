'use client';

import { useState } from 'react';

/** A failed page can be retried without losing the reader's chapter or page. */
export function MangaReaderImage({ src, page, lazy = false }: { src: string; page: number; lazy?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return <div className="lt-reader-image">
    {failed ? <div className="lt-reader-image-error" role="status">
      <p>第 {page} 页加载失败</p>
      <button type="button" className="btn-ghost" onClick={() => { setFailed(false); setAttempt(v => v + 1); }}>重新加载此页</button>
    </div> :
      // Images are served through the existing authenticated manga proxy.
      // eslint-disable-next-line @next/next/no-img-element
      <img key={attempt} src={src} alt={`第 ${page} 页`} loading={lazy ? 'lazy' : 'eager'} decoding="async"
        className="w-full h-auto block" onError={() => setFailed(true)} />}
  </div>;
}
