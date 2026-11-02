import { useCallback, useRef, useState } from 'react';
import { uploadAttachment } from '../../api';
import type { Attachment } from '../../types';

export type Upload = { key: string; name: string; size: number; progress: number; error?: string; abort: () => void };

/** Files upload one by one (a phone on mobile data does better with one stream than five). */
export function useUploads(onUploaded: (a: Attachment) => void) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const queue = useRef(Promise.resolve());
  const seq = useRef(0);
  const patch = (key: string, p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const add = useCallback(
    (reportId: string, files: File[]) => {
      for (const file of files) {
        const key = `u${++seq.current}`;
        let abort = () => {};
        setUploads((u) => [...u, { key, name: file.name, size: file.size, progress: 0, abort: () => abort() }]);
        queue.current = queue.current.then(async () => {
          const job = uploadAttachment(reportId, file, file.name, (f) => patch(key, { progress: f }));
          abort = job.abort;
          try {
            onUploaded(await job.promise);
            setUploads((u) => u.filter((x) => x.key !== key));
          } catch (e) {
            patch(key, { error: (e as Error).message });
          }
        });
      }
    },
    [onUploaded],
  );
  const dismiss = (key: string) => setUploads((u) => u.filter((x) => x.key !== key));
  const busy = uploads.some((u) => !u.error);
  return { uploads, add, dismiss, busy };
}
