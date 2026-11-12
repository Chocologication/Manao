import { useId } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useMotionPreferences } from './motionPreferences';
import { useThemePreferences, type ThemePreference } from './themePreferences';
import styles from './AppearanceSettings.module.css';

const themes = [
  { value: 'light', label: '日间浅色', description: '瓷白底色 · 钴蓝强调', Icon: Sun },
  { value: 'lab', label: '深蓝实验室', description: '午夜蓝底色 · 冰蓝强调', Icon: Moon },
  { value: 'graphite', label: '石墨深色', description: '中性石墨 · 雾蓝强调', Icon: Moon },
  { value: 'system', label: '跟随系统', description: '随系统自动切换明暗', Icon: Monitor },
] satisfies { value: ThemePreference; label: string; description: string; Icon: typeof Sun }[];

export function AppearanceSettings() {
  const id = useId();
  const { preference, theme, setPreference } = useThemePreferences();
  const motion = useMotionPreferences();
  const activeLabel = themes.find((option) => option.value === theme)!.label;

  return <div className={styles.settings}>
    <div className={styles.heading}>
      <div><h3>工作台主题</h3><p>让项目、编辑器与终端保持统一配色。</p></div>
      <span className={styles.current} role="status"><span aria-hidden="true" />{preference === 'system' ? '系统 · ' : '当前 · '}{activeLabel}</span>
    </div>
    <fieldset className={styles.options}>
      <legend className="sr-only">选择工作台主题</legend>
      {themes.map(({ value, label, description, Icon }) => <label key={value} className={styles.option} data-selected={preference === value}>
        <input type="radio" name={`${id}-theme`} value={value} checked={preference === value}
          aria-labelledby={`${id}-${value}-label`} aria-describedby={`${id}-${value}-description`}
          onChange={() => setPreference(value)} />
        <span className={styles.preview} data-palette={value} aria-hidden="true">
          <span className={styles.previewBar}><b /><i /><i /><em /></span>
          <span className={styles.previewBody}>
            <span className={styles.previewSidebar}><i /><i /><i /></span>
            <span className={styles.previewEditor}><span /><i /><i /><i /><b /></span>
          </span>
          {value === 'system' && <span className={styles.systemBadge}><Monitor size={12} />自动</span>}
        </span>
        <span className={styles.optionTitle}><Icon size={15} aria-hidden="true" /><span id={`${id}-${value}-label`}>{label}</span>
          <span className={styles.check} aria-hidden="true">{preference === value && <Check size={12} strokeWidth={2.5} />}</span>
        </span>
        <span id={`${id}-${value}-description`} className={styles.description}>{description}</span>
      </label>)}
    </fieldset>
    <p className={styles.saved}>即时生效，自动保存在此浏览器。</p>
    <label className={styles.motion}>
      <span><span id={`${id}-motion-label`} className={styles.motionTitle}>界面动态效果</span><span id={`${id}-motion-description`} className={styles.motionHint}>系统减少动态效果设置始终优先。</span></span>
      <input type="checkbox" checked={motion.enabled} aria-labelledby={`${id}-motion-label`} aria-describedby={`${id}-motion-description`}
        onChange={(event) => motion.setEnabled(event.target.checked)} />
    </label>
  </div>;
}
