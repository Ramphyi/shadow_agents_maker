import { useEffect, useRef } from 'react';
import { portraits, type SpriteState } from '../sprites/engine';
import type { SpriteId } from '../sprites/models';

/** A live voxel portrait. Rendered small and scaled up without smoothing, so it stays pixel-sharp. */
export function Sprite({ sprite, color, state = 'idle', size = 64 }: { sprite: SpriteId; color: string; state?: SpriteState; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return portraits.add({ canvas: ref.current, sprite, color, state, phase: Math.random() * 6 });
  }, [sprite, color, state]);
  return <canvas ref={ref} className="sprite" style={{ width: size, height: size }} aria-hidden="true" />;
}
