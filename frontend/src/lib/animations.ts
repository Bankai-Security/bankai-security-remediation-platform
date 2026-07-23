import type { Transition, Variants } from 'framer-motion';

// Default enter recipe (Jakub Krehel): blur-up spring, no bounce.
export const springEnter: Transition = { type: 'spring', duration: 0.45, bounce: 0 };

// `custom` (number) staggers the reveal without touching hover/tap timing —
// pass custom={index} on the motion element to offset by 50ms per item.
export const enterBlur: Variants = {
  hidden: { opacity: 0, translateY: 8, filter: 'blur(4px)' },
  visible: (index: number = 0) => ({
    opacity: 1,
    translateY: 0,
    filter: 'blur(0px)',
    transition: { ...springEnter, delay: index * 0.05 },
  }),
};

// Reduced-motion variant: opacity only, no transform/blur.
export const enterFade: Variants = {
  hidden: { opacity: 0 },
  visible: (index: number = 0) => ({
    opacity: 1,
    transition: { duration: 0.3, delay: index * 0.05 },
  }),
};

// Hero: parent staggers its children through enterBlur.
export const staggerParent: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};

// Scroll-reveal viewport config, shared by every useInView section.
export const viewportOnce = { once: true, margin: '-80px 0px' } as const;

// FAQ accordion / mobile menu: height + opacity, exit faster than enter.
export const collapseOpen: Variants = {
  collapsed: { height: 0, opacity: 0, transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } },
  open: {
    height: 'auto',
    opacity: 1,
    transition: { height: springEnter, opacity: { duration: 0.25, delay: 0.05 } },
  },
};

// Micro-interactions for buttons and interactive cards.
export const tapScale = { scale: 0.97 } as const;
export const hoverLift = { y: -2 } as const;
