import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ArrowRight, Box, Code2, Sparkles } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useReducedMotion } from '@/features/preferences/motionPreferences';
import { EntryAtmosphere } from './EntryAtmosphere';
import { EntryLab } from './EntryLab';
import styles from './LoginPage.module.css';

gsap.registerPlugin(useGSAP);
const SharedEntry = createContext(false);
type EntryProps = { children: ReactNode; mode?: 'login' | 'register'; title?: string };
const features = [
  { Icon: Code2, title: '多语言开发', detail: 'Java · Python · Node.js' },
  { Icon: Box, title: '独立运行环境', detail: '代码、依赖与日志集中管理' },
  { Icon: Sparkles, title: 'AI 协作', detail: '从理解代码到执行任务' },
];

/** Keep the scene mounted across account routes; re-entering the area replays the intro. */
export function EntryRouteLayout() {
  const { pathname } = useLocation();
  const title = pathname === '/register' ? '创建账号' : pathname === '/forgot-password' ? '找回密码' : '登录';
  return <SharedEntry.Provider value={true}>
    <EntryScene mode={pathname === '/login' ? 'login' : 'register'} title={title}><Outlet /></EntryScene>
  </SharedEntry.Provider>;
}

export function EntryLayout(props: EntryProps) {
  const shared = useContext(SharedEntry);
  return shared ? props.children : <EntryScene {...props} />;
}

function EntryScene({ children, mode = 'login', title = '登录' }: EntryProps) {
  const containerRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const completedRef = useRef(false);
  const introRef = useRef({ progress: 0 });
  const reducedMotion = useReducedMotion();
  const [ready, setReady] = useState(reducedMotion);

  useEffect(() => () => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
  }, []);

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} | Manao 云端开发实验室`;
    return () => { document.title = previous; };
  }, [title]);

  useGSAP(() => {
    const root = containerRef.current;
    if (!root) return;
    const finish = () => {
      introRef.current.progress = 1;
      completedRef.current = true;
      setReady(true);
    };
    if (reducedMotion || completedRef.current) {
      finish();
      return;
    }
    const timeline = gsap.timeline({ defaults: { ease: 'power3.inOut' }, onComplete: finish });
    timelineRef.current = timeline;
    timeline
      .fromTo(introRef.current, { progress: 0 }, { progress: 1, duration: 4.5, ease: 'none' }, 0)
      .fromTo('.entry__atmosphere', { opacity: 0 }, { opacity: 1, duration: 1.2 }, 0)
      .fromTo('.entry__lab', { opacity: 0, scale: .65, y: -30 }, { opacity: 1, scale: 1, y: 0, duration: 2.7 }, .4)
      .fromTo('.entry__intro', { x: () => root.clientWidth * .18 }, { x: 0, duration: 1.2 }, 2.7)
      .fromTo('.entry__identity', { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 1 }, 2.1)
      .fromTo('.entry__features, .entry__footer', { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: .8 }, 3.5)
      .fromTo('.entry__console', { autoAlpha: 0, x: 70, rotationY: -16, scale: .95 },
        { autoAlpha: 1, x: 0, rotationY: 0, scale: 1, duration: 1.1, clearProps: 'transform' }, 3.4);
    const onVisibility = () => { if (!completedRef.current) timeline.paused(document.hidden); };
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      timelineRef.current = null;
    };
  }, { scope: containerRef, dependencies: [reducedMotion], revertOnUpdate: true });

  function skipIntro() {
    timelineRef.current?.progress(1);
    introRef.current.progress = 1;
    completedRef.current = true;
    setReady(true);
    // Focus after React removes inert, so keyboard users can immediately sign in.
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      panelRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    });
  }

  return <main ref={containerRef} className={`manao-entry ${styles.page}${mode === 'register' ? ' entry--register' : ''}`}
    data-entry-phase={ready ? 'ready' : 'intro'} data-reduced-motion={reducedMotion}>
    <EntryAtmosphere reducedMotion={reducedMotion} ready={ready} intro={introRef.current} />
    <div className="entry__layout">
      <header className="entry__header">
        <Link to="/login" className="entry__brand" aria-label="码瑙首页">
          <span className="entry__brand-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20V4l9 7 9-7v16M8 20v-6l4 3 4-3v6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg></span>
          <span className="entry__brand-name"><strong>Manao<span>码瑙</span></strong><span>云端开发实验室</span></span>
        </Link>
        <div className="entry__header-note">让灵感，在云端运行。</div>
        {!ready && <button type="button" className="entry__skip" onClick={skipIntro}>跳过动画 <ArrowRight size={15} /></button>}
        {ready && <span className="entry__nav-status"><span />代码 · 环境 · AI</span>}
      </header>
      <div className="entry__content">
        <section className="entry__intro" aria-labelledby="entry-title">
          <div className="entry__identity">
            <p className="entry__eyebrow"><span /> 从一行代码，到无限可能</p>
            <h1 id="entry-title" className="entry__title"><span className="entry__title-brand">Manao<span className="entry__title-dot">.</span></span><span className="entry__title-line--accent">云端开发实验室</span></h1>
            <p className="entry__copy">编写、运行、探索。<br />与 AI 一起，把想法变成下一次突破。</p>
          </div>
          <EntryLab reducedMotion={reducedMotion} />
          <div className="entry__features" aria-label="平台功能">
            {features.map(({ Icon, title: label, detail }) => <div className="entry__feature" key={label}><Icon size={17} aria-hidden="true" /><span><strong>{label}</strong><small>{detail}</small></span></div>)}
          </div>
        </section>
        <div ref={panelRef} className="entry__console" inert={!ready}>
          <div className="entry__console-bar"><span><i />开发控制台</span><span aria-hidden="true">01 / MANAO</span></div>
          {children}
          <div className="entry__console-bottom"><span>你的下一次创造，从这里开始</span><span aria-hidden="true">↗</span></div>
        </div>
      </div>
      <footer className="entry__footer"><span>Manao 码瑙 <i /> 为探索而构建</span><span>Java / Python / JavaScript / TypeScript</span></footer>
    </div>
  </main>;
}
