import type { Transition, Variants } from 'framer-motion';

/**
 * 快速弹性 - 用于主要交互（面板切换、对话框等）
 * 体感时长约 150-200ms
 */
export const springFast: Transition = {
  type: 'spring',
  stiffness: 500,
  damping: 30,
  mass: 0.8,
};

/**
 * 标准弹性 - 用于面板伸缩等布局动画
 * 与现有 panelTransition 保持一致
 */
export const springStandard: Transition = {
  type: 'spring',
  stiffness: 400,
  damping: 30,
};

/**
 * 淡入淡出
 */
export const fadeVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};
