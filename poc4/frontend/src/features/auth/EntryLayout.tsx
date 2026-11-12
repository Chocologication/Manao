import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { Check } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useReducedMotion } from '@/features/preferences/motionPreferences';
import { EntryAtmosphere } from './EntryAtmosphere';
import styles from './LoginPage.module.css';

gsap.registerPlugin(useGSAP);

export function EntryLayout({ children, mode = 'login', title }: { children: ReactNode; mode?: 'login' | 'register'; title?: string }) {
  const containerRef = useRef<HTMLElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const previousTitle = document.title;
    document.title = title ? `${title} | 码瑙` : mode === 'register' ? '注册账号 | 码瑙' : '码瑙 | 可复现云端实验平台';
    return () => {
      document.title = previousTitle;
    };
  }, [mode, title]);

  useGSAP(
    () => {
      const root = containerRef.current;
      if (!root) return;

      if (reducedMotion) return;

      root.dataset.motionReady = 'true';
      const timeline = gsap.timeline({
        // Release inline styles so CSS can handle disabled, hover and active states.
        defaults: { ease: 'power3.out', clearProps: 'opacity,transform' },
      });

      timeline
        .addLabel('field', 0)
        .addLabel('identity', 0.22)
        .addLabel('details', 0.44)
        .addLabel('access', 0.58)
        .fromTo(root, { opacity: 0.98 }, { opacity: 1, duration: 0.24 }, 0)
        .fromTo(
          '.entry__brand, .entry__nav-status',
          { opacity: 0, y: -8 },
          { opacity: 1, y: 0, duration: 0.48, stagger: 0.08 },
          'field',
        )
        .fromTo('.entry__instrument', { opacity: 0, scale: 0.94, y: 12 },
          { opacity: 1, scale: 1, y: 0, duration: 0.72 }, 'field+=0.12')
        .fromTo(
          '.entry__title-line',
          { opacity: 0, y: 32 },
          { opacity: 1, y: 0, duration: 0.68, stagger: 0.12 },
          'identity',
        )
        .fromTo(
          '.entry__copy, .entry__feature',
          { opacity: 0, y: 18 },
          { opacity: 1, y: 0, duration: 0.48, stagger: 0.06 },
          'details',
        )
        .fromTo(
          '.entry__form',
          { opacity: 0.92, y: 16 },
          { opacity: 1, y: 0, duration: 0.54 },
          'identity+=0.1',
        )
        .fromTo('.entry__form-heading, .entry__form-meta, .entry__field',
          { opacity: 0.92, y: 8 },
          { opacity: 1, y: 0, duration: 0.38, stagger: 0.055 }, 'access')
        .fromTo('.entry__submit, .entry__demo-hint', { opacity: 0.92, y: 6 },
          { opacity: 1, y: 0, duration: 0.32, stagger: 0.06 }, 'access+=0.22')
        .fromTo('.entry__footer', { opacity: 0 }, { opacity: 1, duration: 0.4 }, 'details');

      return () => { delete root.dataset.motionReady; };
    },
    { scope: containerRef, dependencies: [reducedMotion], revertOnUpdate: true },
  );

  return (
    <main
      ref={containerRef}
      className={`manao-entry ${styles.page}${mode === 'register' ? ' entry--register' : ''}`}
    >
      <EntryAtmosphere reducedMotion={reducedMotion} />
      <div className="entry__layout">
        <header className="entry__header">
          <a
            href="/login"
            className="entry__brand"
            aria-label="码瑙首页"
          >
            <span className="entry__brand-mark">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 21V5l9 6 9-6v16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="miter" />
                <circle cx="12" cy="13" r="1.6" fill="currentColor" />
              </svg>
            </span>
            <span className="entry__brand-name">
              <strong>码瑙</strong>
              <span>MANAO · CLOUD LAB</span>
            </span>
          </a>
          <div className="entry__nav-links" aria-label="平台能力">
            <span>实验环境</span>
            <span>运行记录</span>
          </div>
          <span className="entry__nav-status">
            <span aria-hidden="true" /> 云端代码实验室
          </span>
        </header>

        <div className="entry__content">
          <section className="entry__intro" aria-labelledby="entry-title">
            <h1 id="entry-title" className="entry__title">
              <span className="entry__title-line">Manao 码瑙</span>
              <span className="entry__title-line entry__title-line--accent">云端代码实验室</span>
            </h1>
            <p className="entry__copy">
              集中管理项目代码、运行环境与执行记录，在工作台中完成 AI 辅助开发。
            </p>

            <div className="entry__features" aria-label="平台功能">
              {[
                ['Java / Python / Node.js', '支持 JavaScript 与 TypeScript 项目'],
                ['AI 诊断', '协助理解运行问题'],
                ['运行记录', '查看执行结果与日志'],
              ].map(([title, description]) => (
                <div className="entry__feature" key={title}>
                  <span className="entry__feature-mark"><Check size={14} aria-hidden="true" /></span>
                  <span><strong>{title}</strong><small>{description}</small></span>
                </div>
              ))}
            </div>
          </section>

          {children}
        </div>
        <footer className="entry__footer">
          <div className="entry__footer-brand">
            <span className="entry__footer-mark" aria-hidden="true">M</span>
            <span>
              <strong>码瑙</strong>
              <small>可复现云端实验平台</small>
            </span>
          </div>
          <span className="entry__footer-capabilities">代码 <i /> 运行 <i /> 记录 <i /> AI</span>
        </footer>
      </div>
    </main>
  );
}
