import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { ReasoningEffort } from '@/contracts/agentTask';
import './AgentChat.css';
export type ReasoningEffortPickerProps = { value: ReasoningEffort; disabled: boolean; active: boolean; onChange: (value: ReasoningEffort) => void };
const EFFORTS = ['off', 'low', 'high', 'max'] as const;
const LABELS = ['关闭', '低', '高', '最高'] as const;
const DESCRIPTIONS = ['不启用额外推理。', '使用较少的推理。', '使用较高的推理强度。', '使用最高的推理强度。'] as const;
export function ReasoningEffortPicker({ value, disabled, active, onChange }: ReasoningEffortPickerProps) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const index = EFFORTS.indexOf(value);
  useEffect(() => { if (!active || disabled) setOpen(false); }, [active, disabled]);
  const change = (next: number) => {
    const effort = EFFORTS[next];
    if (!disabled && active && effort !== undefined) onChange(effort);
  };
  return <Popover.Root open={open && active && !disabled} onOpenChange={setOpen}>
    <Popover.Trigger type="button" disabled={disabled} className="manao-ai-effort-trigger">推理强度 · {LABELS[index]} <span aria-hidden="true">⌄</span></Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={12} className="manao-ai-effort-positioner">
        <Popover.Popup className="manao-ai-effort-popup" finalFocus={() => active && !disabled}>
          <Popover.Title className="manao-ai-effort-title">推理强度</Popover.Title>
          <div className="manao-ai-effort-control" style={{ '--manao-ai-effort-position': index / 3 } as CSSProperties}>
            <div className="manao-ai-effort-decoration" aria-hidden="true">
              <div className="manao-ai-effort-track"><div className="manao-ai-effort-fill" /></div>
              <span className="manao-ai-effort-capsule">{LABELS[index]}</span>
            </div>
            <input type="range" min={0} max={3} step={1} value={index} disabled={disabled}
              aria-label="推理强度" aria-valuetext={LABELS[index]} aria-describedby={descriptionId}
              onChange={event => change(Number(event.currentTarget.value))} />
          </div>
          <div className="manao-ai-effort-ticks">{LABELS.map((label, tick) => <button key={label} type="button" disabled={disabled} aria-pressed={tick === index} onClick={() => change(tick)}>{label}</button>)}</div>
          <p id={descriptionId} className="manao-ai-effort-description">{DESCRIPTIONS[index]}</p>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
