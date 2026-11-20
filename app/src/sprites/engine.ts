import * as THREE from 'three';
import { GLYPHS, SPRITE_MAPS, type SpriteId } from './models';

export type SpriteState = 'idle' | 'working' | 'waiting' | 'error' | 'paused';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const LIT = new THREE.MeshLambertMaterial({ color: 0xffffff });
const MAX_HALF_DEPTH = 3;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function palette(hex: string, dim: boolean) {
  const body = new THREE.Color(hex);
  if (dim) {
    // A paused shadow keeps a trace of its color but reads as switched off.
    const hsl = { h: 0, s: 0, l: 0 };
    body.getHSL(hsl);
    body.setHSL(hsl.h, hsl.s * 0.22, hsl.l * 0.62);
  }
  return {
    b: body,
    d: body.clone().offsetHSL(0, 0, -0.15),
    l: body.clone().offsetHSL(0, 0, 0.13),
    a: dim ? body.clone().offsetHSL(0, 0, 0.1) : body.clone().offsetHSL(0.45, 0.1, 0.08),
    w: new THREE.Color(dim ? 0xb9bccb : 0xffffff),
    e: new THREE.Color(0x15131f),
    k: new THREE.Color(0x15131f),
  };
}

/** Inflate a pixel map into voxels: each pixel's column is as deep as the pixel is far from the outline. */
export function buildSprite(sprite: SpriteId, color: string, dim = false): THREE.InstancedMesh {
  const map = SPRITE_MAPS[sprite] ?? SPRITE_MAPS.wisp;
  const rows = map.length; const cols = map[0].length;
  const filled = (r: number, c: number) => r >= 0 && r < rows && c >= 0 && c < cols && map[r][c] !== '.';
  const depth = (r: number, c: number) => {
    for (let d = 1; d <= MAX_HALF_DEPTH; d++) {
      for (let dr = -d; dr <= d; dr++) for (let dc = -d; dc <= d; dc++) if (!filled(r + dr, c + dc)) return d;
    }
    return MAX_HALF_DEPTH;
  };
  const pal = palette(color, dim);
  const cells: { x: number; y: number; z: number; color: THREE.Color }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = map[r][c] as keyof typeof pal | '.';
      if (ch === '.') continue;
      const h = depth(r, c);
      for (let z = -h; z < h; z++) {
        const front = z === h - 1;
        const surfaceOnly = ch === 'w' || ch === 'e' || ch === 'k';
        cells.push({ x: c - (cols - 1) / 2, y: rows - 1 - r + 0.5, z: z + 0.5, color: surfaceOnly && !front ? pal.b : pal[ch] });
      }
    }
  }
  const mesh = new THREE.InstancedMesh(BOX, LIT, cells.length);
  const m = new THREE.Matrix4();
  cells.forEach((cell, i) => {
    mesh.setMatrixAt(i, m.makeTranslation(cell.x, cell.y, cell.z));
    mesh.setColorAt(i, cell.color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function buildGlyph(kind: keyof typeof GLYPHS): THREE.Group {
  const colors: Record<string, number> = { y: 0xffc94d, z: 0x9aa3ff, r: 0xff5d73 };
  const group = new THREE.Group();
  const map = GLYPHS[kind];
  map.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch === '.') return;
    const cube = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: colors[ch] }));
    cube.position.set(c - (row.length - 1) / 2, map.length - 1 - r, 0);
    group.add(cube);
  }));
  return group;
}

function addLights(scene: THREE.Scene) {
  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(0.6, 1, 0.9);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8b7bff, 0.9);
  rim.position.set(-1, 0.3, -0.6);
  scene.add(rim);
}

/** The motion that tells you what a shadow is doing, shared by portraits and the realm. */
function pose(target: THREE.Object3D, state: SpriteState, t: number, phase: number) {
  if (reducedMotion()) { target.position.y = 0; target.rotation.set(0, 0.35, state === 'error' ? 0.2 : 0); return; }
  target.rotation.set(0, 0, 0);
  target.scale.setScalar(1);
  switch (state) {
    case 'working':
      target.position.y = Math.abs(Math.sin(t * 5 + phase)) * 2.4;
      target.rotation.y = t * 2.6 + phase;
      break;
    case 'waiting':
      target.position.y = 0.3;
      target.rotation.y = 0.3;
      target.rotation.z = Math.sin(t * 16) * 0.07;
      break;
    case 'error':
      target.position.y = 0;
      target.rotation.y = 0.3;
      target.rotation.z = 0.22 + Math.sin(t * 2 + phase) * 0.03;
      break;
    case 'paused':
      target.position.y = 0;
      target.rotation.y = 0.3;
      target.scale.y = 0.95 + Math.sin(t * 1.2 + phase) * 0.025;
      break;
    default:
      target.position.y = Math.sin(t * 1.8 + phase) * 0.7 + 0.7;
      target.rotation.y = 0.3 + Math.sin(t * 0.7 + phase) * 0.35;
  }
}

// ── portraits ───────────────────────────────────────────────────────────
// Browsers allow only a handful of WebGL contexts, so every portrait in the app shares one renderer:
// it draws each sprite in turn and copies the pixels into that portrait's 2D canvas.

interface Portrait { canvas: HTMLCanvasElement; sprite: SpriteId; color: string; state: SpriteState; phase: number }

const PORTRAIT_PX = 56;
class PortraitRenderer {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-8.2, 8.2, 8.2, -8.2, 0.1, 200);
  private holder = new THREE.Group();
  private cache = new Map<string, THREE.InstancedMesh>();
  private items = new Set<Portrait>();
  private raf = 0;
  private last = 0;

  constructor() {
    addLights(this.scene);
    this.scene.add(this.holder);
    this.camera.position.set(14, 16, 40);
    this.camera.lookAt(0, 7.2, 0);
  }

  private mesh(p: Portrait) {
    const dim = p.state === 'paused';
    const key = `${p.sprite}|${p.color}|${dim}`;
    let mesh = this.cache.get(key);
    if (!mesh) {
      if (this.cache.size > 80) { for (const m of this.cache.values()) m.dispose(); this.cache.clear(); }
      mesh = buildSprite(p.sprite, p.color, dim);
      this.cache.set(key, mesh);
    }
    return mesh;
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    if (now - this.last < 40) return; // 25 fps is plenty for chunky pixels
    this.last = now;
    if (!this.renderer) {
      try {
        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true });
      } catch { cancelAnimationFrame(this.raf); return; }
      this.renderer.setSize(PORTRAIT_PX, PORTRAIT_PX, false);
    }
    const t = now / 1000;
    for (const p of this.items) {
      const mesh = this.mesh(p);
      this.holder.clear();
      this.holder.add(mesh);
      pose(mesh, p.state, t, p.phase);
      this.renderer.render(this.scene, this.camera);
      const ctx = p.canvas.getContext('2d');
      if (!ctx) continue;
      ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
      ctx.drawImage(this.renderer.domElement, 0, 0, p.canvas.width, p.canvas.height);
    }
  };

  add(p: Portrait) {
    p.canvas.width = PORTRAIT_PX; p.canvas.height = PORTRAIT_PX;
    this.items.add(p);
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
    return () => {
      this.items.delete(p);
      if (!this.items.size) { cancelAnimationFrame(this.raf); this.raf = 0; }
    };
  }
}
export const portraits = new PortraitRenderer();

// ── the realm ───────────────────────────────────────────────────────────

export interface RealmAgent { id: string; name: string; sprite: SpriteId; color: string; state: SpriteState; detail: string }

interface Actor {
  agent: RealmAgent;
  root: THREE.Group; body: THREE.Group; mesh: THREE.InstancedMesh;
  plate: THREE.Mesh; sparks: THREE.Group; glyphs: Record<keyof typeof GLYPHS, THREE.Group>;
  hit: THREE.Mesh; label: HTMLButtonElement; phase: number; born: number; key: string;
}

const PIXEL = 3; // one rendered pixel covers 3×3 screen pixels
const STATE_COLOR: Record<SpriteState, number> = { idle: 0x3a3f66, working: 0x39d0ff, waiting: 0xffc94d, error: 0xff5d73, paused: 0x262a40 };
const STATE_TEXT: Record<SpriteState, string> = { idle: 'Idle', working: 'Working', waiting: 'Needs you', error: 'Problem', paused: 'Paused' };

export class RealmStage {
  private container: HTMLElement;
  private onSelect: (id: string) => void;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
  private actors = new Map<string, Actor>();
  private labels: HTMLDivElement;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(9, 9);
  private hovered: string | null = null;
  private selected: string | null = null;
  private raf = 0;
  private observer: ResizeObserver;
  private extent = { w: 40, d: 20 };

  constructor(container: HTMLElement, onSelect: (id: string) => void) {
    this.container = container;
    this.onSelect = onSelect;
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
    this.renderer.setPixelRatio(1);
    const canvas = this.renderer.domElement;
    canvas.className = 'realm-canvas';
    container.appendChild(canvas);
    this.labels = document.createElement('div');
    this.labels.className = 'realm-labels';
    container.appendChild(this.labels);
    addLights(this.scene);
    this.camera.position.set(80, 150, 200);
    this.camera.lookAt(0, 3, 0);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('click', this.onClick);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  private onMove = (e: PointerEvent) => {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  private onLeave = () => { this.pointer.set(9, 9); };
  private onClick = () => { if (this.hovered) this.onSelect(this.hovered); };

  private resize() {
    const w = Math.max(this.container.clientWidth, 10); const h = Math.max(this.container.clientHeight, 10);
    this.renderer.setSize(Math.ceil(w / PIXEL), Math.ceil(h / PIXEL), false);
    // Fit the whole layout with some air, whatever the window shape.
    const aspect = w / h;
    const needW = this.extent.w / 2 + 20; const needH = this.extent.d * 0.29 + 24;
    const half = Math.max(needH, needW / aspect);
    this.camera.left = -half * aspect; this.camera.right = half * aspect;
    this.camera.top = half; this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
  }

  setSelected(id: string | null) {
    this.selected = id;
    for (const a of this.actors.values()) a.label.classList.toggle('is-selected', a.agent.id === id);
  }

  setAgents(list: RealmAgent[]) {
    const seen = new Set(list.map((a) => a.id));
    for (const [id, actor] of this.actors) {
      if (seen.has(id)) continue;
      this.scene.remove(actor.root);
      actor.mesh.dispose();
      actor.label.remove();
      this.actors.delete(id);
    }
    const cols = Math.max(1, Math.min(list.length, Math.ceil(Math.sqrt(list.length * 1.5))));
    const rows = Math.ceil(list.length / cols);
    // Rows sit far enough apart that a back row's name tag clears the sprites in front of it.
    const SX = 30; const SZ = 50;
    this.extent = { w: (cols - 1) * SX + 18, d: (rows - 1) * SZ + 18 };
    list.forEach((agent, i) => {
      const row = Math.floor(i / cols); const col = i % cols;
      const inRow = row === rows - 1 ? list.length - row * cols : cols;
      const x = (col - (inRow - 1) / 2) * SX + (rows > 1 && row % 2 === 1 && inRow === cols ? SX / 2 : 0);
      const z = (row - (rows - 1) / 2) * SZ;
      let actor = this.actors.get(agent.id);
      const key = `${agent.sprite}|${agent.color}|${agent.state === 'paused'}`;
      if (!actor) {
        actor = this.makeActor(agent, key);
        this.actors.set(agent.id, actor);
      } else if (actor.key !== key) {
        actor.body.remove(actor.mesh);
        actor.mesh.dispose();
        actor.mesh = buildSprite(agent.sprite, agent.color, agent.state === 'paused');
        actor.body.add(actor.mesh);
        actor.key = key;
      }
      actor.agent = agent;
      actor.root.position.set(x, 0, z);
      (actor.plate.material as THREE.MeshBasicMaterial).color.setHex(STATE_COLOR[agent.state]);
      actor.label.dataset.state = agent.state;
      actor.label.querySelector('.realm-name')!.textContent = agent.name;
      actor.label.querySelector('.realm-state')!.textContent = agent.state === 'idle' && agent.detail ? agent.detail : STATE_TEXT[agent.state];
      actor.label.setAttribute('aria-label', `${agent.name}, ${STATE_TEXT[agent.state]}`);
    });
    this.setSelected(this.selected);
    this.resize();
  }

  private makeActor(agent: RealmAgent, key: string): Actor {
    const root = new THREE.Group();
    const slab = new THREE.Mesh(new THREE.BoxGeometry(17, 3, 17), new THREE.MeshLambertMaterial({ color: 0x1b1e30 }));
    slab.position.y = -1.5;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(15, 0.6, 15), new THREE.MeshBasicMaterial({ color: STATE_COLOR[agent.state] }));
    plate.position.y = 0.1;
    const top = new THREE.Mesh(new THREE.BoxGeometry(13, 0.6, 13), new THREE.MeshLambertMaterial({ color: 0x232741 }));
    top.position.y = 0.3;
    root.add(slab, plate, top);

    const body = new THREE.Group();
    body.position.y = 0.6;
    const mesh = buildSprite(agent.sprite, agent.color, agent.state === 'paused');
    body.add(mesh);
    root.add(body);

    const sparks = new THREE.Group();
    const sparkMat = new THREE.MeshBasicMaterial({ color: agent.color });
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(BOX, sparkMat);
      s.scale.setScalar(1.3);
      sparks.add(s);
    }
    sparks.position.y = 7;
    root.add(sparks);

    const glyphs = { alert: buildGlyph('alert'), sleep: buildGlyph('sleep'), error: buildGlyph('error') };
    for (const g of Object.values(glyphs)) { g.position.set(0, 17, 0); g.visible = false; root.add(g); }

    const hit = new THREE.Mesh(new THREE.BoxGeometry(15, 20, 12), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 7;
    hit.userData.id = agent.id;
    root.add(hit);

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'realm-label';
    label.innerHTML = '<span class="realm-name"></span><span class="realm-state"></span>';
    label.addEventListener('click', () => this.onSelect(agent.id));
    this.labels.appendChild(label);

    this.scene.add(root);
    return { agent, root, body, mesh, plate, sparks, glyphs, hit, label, phase: Math.random() * 6, born: performance.now(), key };
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const t = now / 1000;
    const w = this.container.clientWidth; const h = this.container.clientHeight;
    const still = reducedMotion();

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.actors.values()].map((a) => a.hit), false);
    const hovered = (hits[0]?.object.userData.id as string | undefined) ?? null;
    if (hovered !== this.hovered) {
      this.hovered = hovered;
      this.renderer.domElement.style.cursor = hovered ? 'pointer' : 'default';
      for (const a of this.actors.values()) a.label.classList.toggle('is-hover', a.agent.id === hovered);
    }

    const v = new THREE.Vector3();
    for (const actor of this.actors.values()) {
      const { agent } = actor;
      pose(actor.mesh, agent.state, t, actor.phase);
      // New shadows pop in.
      const age = (now - actor.born) / 650;
      const grow = still || age >= 1 ? 1 : 1 - Math.pow(1 - age, 3) * Math.cos(age * 9);
      const lift = !still && (this.hovered === agent.id || this.selected === agent.id) ? 1.08 : 1;
      actor.body.scale.setScalar(Math.max(0.001, grow) * lift);

      actor.sparks.visible = agent.state === 'working';
      if (actor.sparks.visible) {
        actor.sparks.children.forEach((s, i) => {
          const a = t * 2.2 + (i / 6) * Math.PI * 2;
          s.position.set(Math.cos(a) * 9.5, Math.sin(t * 3 + i) * 4, Math.sin(a) * 9.5);
        });
      }
      actor.glyphs.alert.visible = agent.state === 'waiting';
      actor.glyphs.sleep.visible = agent.state === 'paused';
      actor.glyphs.error.visible = agent.state === 'error';
      for (const g of Object.values(actor.glyphs)) if (g.visible) g.position.y = 17 + (still ? 0 : Math.sin(t * 3 + actor.phase) * 0.8);
      if (agent.state === 'waiting' && !still) {
        (actor.plate.material as THREE.MeshBasicMaterial).color.setHex(Math.sin(t * 6) > 0 ? 0xffc94d : 0x8a6a1f);
      }

      v.set(actor.root.position.x, -3.5, actor.root.position.z + 9).project(this.camera);
      actor.label.style.transform = `translate(-50%, 0) translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    for (const a of this.actors.values()) a.mesh.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.remove();
  }
}
