import { useEffect, useRef } from 'react';
import { animate, stagger } from 'animejs';

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Children marked data-enter rise in, one after another, when the view mounts or `key` changes. */
export function useEnter<T extends HTMLElement>(key: unknown = 0) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLElement>('[data-enter]');
    if (!items?.length || still()) return;
    animate(items, { opacity: [0, 1], y: [14, 0], duration: 520, delay: stagger(45), ease: 'outExpo' });
  }, [key]);
  return ref;
}

export function slideIn(el: HTMLElement | null, from: 'right' | 'up' = 'right') {
  if (!el || still()) return;
  animate(el, from === 'right'
    ? { x: [48, 0], opacity: [0, 1], duration: 420, ease: 'outExpo' }
    : { y: [24, 0], scale: [0.97, 1], opacity: [0, 1], duration: 380, ease: 'outExpo' });
}

export function pulse(el: HTMLElement | null) {
  if (!el || still()) return;
  animate(el, { scale: [1, 1.06, 1], duration: 420, ease: 'outQuad' });
}

export function shake(el: HTMLElement | null) {
  if (!el || still()) return;
  animate(el, { x: [0, -6, 6, -4, 4, 0], duration: 360, ease: 'outQuad' });
}

export function popIn(el: HTMLElement | null) {
  if (!el || still()) return;
  animate(el, { scale: [0.6, 1], opacity: [0, 1], duration: 620, ease: 'outElastic(1, .7)' });
}
