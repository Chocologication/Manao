import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { EntryLayout } from './EntryLayout';

type AuthPageFrameProps = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
};

/** Shared account-page frame; keeps the three lifecycle pages visually consistent. */
export function AuthPageFrame({ eyebrow, title, subtitle, children, footer }: AuthPageFrameProps) {
  return <EntryLayout mode="register" title={title}>
    <section className="entry__form" aria-labelledby="account-page-title">
      <div className="entry__form-heading">
        <div><h2 id="account-page-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <span className="entry__security-mark"><ShieldCheck size={20} aria-hidden="true" /></span>
      </div>
      <div className="entry__form-meta"><span>{eyebrow ?? 'MANAO / ACCOUNT'}</span><span>安全验证</span></div>
      <div className="entry__account-content">{children}</div>
      {footer && <div className="entry__account-link">{footer}</div>}
      {import.meta.env.MODE === 'mock' && <div className="entry__demo-hint"><span>演示环境不发送真实邮件，输入任意图形字符和 6 位邮箱验证码。</span></div>}
    </section>
  </EntryLayout>;
}

type AuthFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'password';
  autoComplete?: string;
  placeholder?: string;
  inputMode?: 'text' | 'email' | 'numeric';
  disabled?: boolean;
};

export function AuthField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  placeholder,
  inputMode,
  disabled = false,
}: AuthFieldProps) {
  return (
    <div className="entry__field">
      <label htmlFor={id} >
        {label}
      </label>
      <input
        id={id}
        name={id}
        aria-label={label}
        type={type}
        autoComplete={autoComplete}
        autoFocus={autoComplete === 'one-time-code'}
        inputMode={inputMode}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="entry__input entry__input--plain"
      />
    </div>
  );
}
