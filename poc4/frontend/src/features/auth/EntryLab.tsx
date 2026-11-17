import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { useRef } from 'react';

const examples = [
  { language: 'Python', file: 'hello.py', lines: ['def explore(name: str):', '    return f"Hello, {name}"', '', 'print(explore("Manao"))'] },
  { language: 'Java', file: 'Hello.java', lines: ['class Hello {', '  public static void main(String[] args) {', '    System.out.println("Hello, Manao");', '  }', '}'] },
  { language: 'JavaScript', file: 'hello.js', lines: ['const idea = "Hello, Manao";', '', 'const explore = () => idea;', 'console.log(explore());'] },
  { language: 'TypeScript', file: 'hello.ts', lines: ['type Idea = { name: string };', '', 'const idea: Idea = { name: "Manao" };', 'console.log(idea.name);'] },
];
const links = [
  'M260 187 H340 L405 122 H442',
  'M445 104 H526 L580 56 H680',
  'M445 133 H505 L580 236 H708',
];

export function EntryLab({ reducedMotion }: { reducedMotion: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    const root = rootRef.current;
    if (!root || reducedMotion) return;
    const cards = root.querySelectorAll<HTMLElement>('.entry__code-example');
    const cycle = gsap.timeline({ repeat: -1, defaults: { duration: .65, ease: 'power2.inOut' } });
    for (let i = 0; i < cards.length; i++) {
      cycle.to(cards[i], { autoAlpha: 0, y: -8 }, i * 5 + 4.35)
        .fromTo(cards[(i + 1) % cards.length], { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, immediateRender: false }, i * 5 + 4.35);
    }
    const plane = root.querySelector('.entry__lab-plane');
    const halo = gsap.fromTo('.entry__core-halo', { opacity: .65, scale: .94 },
      { opacity: 1, scale: 1.12, duration: 3.6, repeat: -1, yoyo: true, ease: 'sine.inOut' });
    const pulses = gsap.fromTo('.entry__lab-pulse', { strokeDashoffset: 0 },
      { strokeDashoffset: -100, duration: 4, repeat: -1, ease: 'none', stagger: .8 });
    const floating = gsap.to('.entry__code-card, .entry__node',
      { y: 5, duration: 3.2, repeat: -1, yoyo: true, ease: 'sine.inOut', stagger: .7 });
    const xTo = gsap.quickTo(plane, 'rotationY', { duration: .8, ease: 'power3.out' });
    const yTo = gsap.quickTo(plane, 'rotationX', { duration: .8, ease: 'power3.out' });
    const moveX = gsap.quickTo(plane, 'x', { duration: .8 });
    const moveY = gsap.quickTo(plane, 'y', { duration: .8 });
    const area = root.closest('main')!;
    const onMove = (event: PointerEvent) => {
      if (document.hidden || event.pointerType === 'touch') return;
      const rect = root.getBoundingClientRect();
      const x = gsap.utils.clamp(-1, 1, (event.clientX - rect.left) / rect.width * 2 - 1);
      const y = gsap.utils.clamp(-1, 1, (event.clientY - rect.top) / rect.height * 2 - 1);
      xTo(x * 8); yTo(-y * 6); moveX(x * 10); moveY(y * 6);
    };
    const reset = () => { xTo(0); yTo(0); moveX(0); moveY(0); };
    const onVisibility = () => {
      cycle.paused(document.hidden);
      halo.paused(document.hidden);
      pulses.paused(document.hidden);
      floating.paused(document.hidden);
      for (const to of [xTo, yTo, moveX, moveY]) to.tween.paused(document.hidden);
    };
    area.addEventListener('pointermove', onMove, { passive: true });
    area.addEventListener('pointerleave', reset);
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    return () => {
      area.removeEventListener('pointermove', onMove);
      area.removeEventListener('pointerleave', reset);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, { scope: rootRef, dependencies: [reducedMotion], revertOnUpdate: true });

  return <div ref={rootRef} className="entry__lab" aria-hidden="true">
    <div className="entry__lab-plane">
      <div className="entry__orbit entry__orbit--outer" /><div className="entry__orbit entry__orbit--inner" />
      <svg className="entry__lab-links" viewBox="0 0 800 310" preserveAspectRatio="none">
        {links.map(d => <g key={d}><path d={d} className="entry__lab-link" /><path d={d} pathLength="100" className="entry__lab-pulse" /></g>)}
      </svg>
      <div className="entry__core">
        <div className="entry__core-halo" />
        <svg viewBox="0 0 120 130" className="entry__core-mark"><defs><linearGradient id="entry-crystal" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#f1ffff" /><stop offset=".45" stopColor="#8ae5ff" /><stop offset="1" stopColor="#557cff" /></linearGradient></defs><path d="M12 106V22l48 29 48-29v84L86 118V64L60 81 34 64v54Z" fill="url(#entry-crystal)" fillOpacity=".12" stroke="url(#entry-crystal)" strokeWidth="1.5" /><path d="m12 22 22-12 26 16 26-16 22 12M34 10v54m52-54v54M60 26v55M12 106l22 12m52 0 22-12" fill="none" stroke="#96dfff" strokeOpacity=".6" /><path d="m34 64 26 17 26-17" fill="none" stroke="#e5ffff" strokeWidth="2" /></svg>
        <span className="entry__core-label">创意核心</span>
      </div>
      <div className="entry__code-card">
        <div className="entry__card-top"><span><i /><i /><i /></span><span>代码预览</span></div>
        <div className="entry__code-stack">{examples.map((example, index) => <div className="entry__code-example" data-first={index === 0} key={example.language}>
          <div className="entry__code-heading"><strong>{example.file}</strong><span>{example.language}</span></div>
          <pre>{example.lines.map((line, number) => <span key={number}><i>{String(number + 1).padStart(2, '0')}</i><code>{line || ' '}</code></span>)}</pre>
        </div>)}</div>
        <div className="entry__card-foot"><span>创意 → 代码 → 运行</span><span>示意</span></div>
      </div>
      <div className="entry__node entry__node--ai"><span className="entry__node-icon">✳</span><span><strong>AI 协作</strong><small>理解 · 创造 · 验证</small></span><i /></div>
      <div className="entry__node entry__node--env"><span className="entry__node-icon">⌘</span><span><strong>云端环境</strong><small>让想法即刻启程</small></span><i /></div>
      <span className="entry__scene-caption">云端开发空间 · 视觉示意</span>
    </div>
  </div>;
}
