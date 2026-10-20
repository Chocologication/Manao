import { useState } from 'react';
import { Download } from 'lucide-react';
import type { RunSummary } from '@/contracts/run';
import type { RunLogSnapshot } from '@/features/logs/RunLogStore';
import { createRunEvidence } from '@/features/logs/runEvidence';
import { RUN_ICON_BUTTON_CLASS } from './RunToolbar';

export function RunEvidenceExport({ projectId, run, snapshot }: { projectId: string; run: RunSummary; snapshot: RunLogSnapshot }) {
  const [feedback, setFeedback] = useState('');
  function download() {
    try {
      const evidence = createRunEvidence(projectId, run, snapshot);
      const url = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `manao-run-${run.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFeedback('已导出运行记录与已读取日志');
    } catch { setFeedback('导出失败，请重试'); }
  }
  return <><button type="button" className={RUN_ICON_BUTTON_CLASS} aria-label="导出运行证据" title="导出运行证据 JSON（已读取日志）" onClick={download}><Download size={16} /></button><span role="status" className="sr-only">{feedback}</span></>;
}
