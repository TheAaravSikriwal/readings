// The 3D bubble map. Plain TypeScript around 3d-force-graph; React only talks
// to it through sync() / setView() and the callbacks.
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { forceCollide } from 'd3-force-3d';
import type { Library } from '../types';
import { bubbleMaterial, shared } from './bubbleMaterial';

export const ROOT = '__root';

type Kind = 'root' | 'topic' | 'article';

interface Visual {
  group: THREE.Group;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  haloMesh: THREE.Mesh;
  haloMat: THREE.ShaderMaterial;
  label: CSS2DObject;
  labelEl: HTMLDivElement;
  text: HTMLSpanElement;
  born: number; // ms timestamp the bubble starts growing
  phase: number; // idle float offset
  s: number; // spring scale
  sv: number; // spring velocity
  op: number;
  lab: number;
  labShown: number;
  halo: number;
}

export interface GNode {
  id: string;
  kind: Kind;
  title: string;
  r: number;
  depth: number;
  hidden: boolean;
  annotated: boolean;
  pending: boolean;
  /** brightness targets, set by retarget() and eased toward in tick() */
  opT: number;
  labT: number;
  haloT: number;
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  v?: Visual;
}

export interface GLink {
  id: string;
  kind: 'parent' | 'cross' | 'root';
  source: string | GNode;
  target: string | GNode;
  note?: string;
  mat: THREE.LineBasicMaterial;
  op: number;
  opT: number;
  spark: boolean;
}

export interface MapCallbacks {
  onClick(id: string, ev: MouseEvent): void;
  onDblClick(id: string): void;
  onRightClick(id: string, ev: MouseEvent): void;
  onBackground(): void;
  /** A bubble was dragged onto a topic (null = top level). */
  onDrop(id: string, into: string | null): void;
}

const GEO = new THREE.SphereGeometry(1, 48, 32);
const end = (e: string | GNode) => (typeof e === 'string' ? e : e.id);
const shorten = (s: string, n = 44) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export class MapView {
  private g: ForceGraph3DInstance<GNode, GLink>;
  private controls: OrbitControls;
  private camera: THREE.PerspectiveCamera;
  private fog = new THREE.Fog(0x000000, 300, 1200);
  private root: GNode = {
    id: ROOT, kind: 'root', title: '', r: 0, depth: 0, hidden: false, annotated: false, pending: false,
    opT: 0, labT: 0, haloT: 0, x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0,
  };
  private nodes = new Map<string, GNode>();
  private links = new Map<string, GLink>();
  private signature = '';
  private sparkSig = '';
  private parentOf = new Map<string, string>();
  private kids = new Map<string, string[]>();
  private neighbors = new Map<string, Set<string>>();

  private focus = ROOT;
  private selected: string | null = null;
  private hover: string | null = null;
  private dropTarget: string | null = null;
  private dragging: string | null = null;
  private marked: string | null = null;

  private offset = { x: 0, y: 0 };
  private offsetT = { x: 0, y: 0 };
  private lastClick = { id: '', t: 0 };
  private lastInput = performance.now();
  private lastFrame = 0;
  private framedOnce = false;
  private introUntil = 0;
  private paused = false;
  private raf = 0;
  private ro: ResizeObserver;

  constructor(private el: HTMLElement, private cb: MapCallbacks, editable: boolean) {
    const labels = new CSS2DRenderer();
    labels.domElement.className = 'labels';

    this.g = new ForceGraph3D(el, { controlType: 'orbit', extraRenderers: [labels as any] }) as unknown as ForceGraph3DInstance<GNode, GLink>;
    this.camera = this.g.camera() as THREE.PerspectiveCamera;
    this.controls = this.g.controls() as OrbitControls;
    this.g.scene().fog = this.fog;

    this.g
      .width(el.clientWidth)
      .height(el.clientHeight)
      .backgroundColor('#000000')
      .showNavInfo(false)
      .nodeId('id')
      .nodeLabel(() => '')
      .nodeThreeObject((n: GNode) => this.objectFor(n))
      .nodeThreeObjectExtend(false)
      .linkVisibility((l: GLink) => l.kind !== 'root')
      .linkWidth(0)
      .linkMaterial((l: GLink) => l.mat)
      .linkLabel((l: GLink) => (l.kind === 'cross' && l.note ? `<div class="tip">${esc(l.note)}</div>` : ''))
      .linkHoverPrecision(2)
      .linkDirectionalParticles(0)
      .linkDirectionalParticleWidth(0.8)
      .linkDirectionalParticleSpeed(0.0032)
      .linkDirectionalParticleColor(() => '#ffffff')
      .enableNodeDrag(editable)
      .d3AlphaDecay(0.022)
      .d3VelocityDecay(0.32)
      .cooldownTime(9000)
      .onNodeClick((n: GNode, ev: MouseEvent) => this.handleClick(n, ev))
      .onNodeRightClick((n: GNode, ev: MouseEvent) => n.kind !== 'root' && cb.onRightClick(n.id, ev))
      .onNodeHover((n: GNode | null) => {
        const id = n && n.kind !== 'root' ? n.id : null;
        el.style.cursor = id ? 'pointer' : '';
        if (id !== this.hover) {
          this.hover = id;
          this.retarget();
        }
      })
      .onBackgroundClick(() => cb.onBackground())
      .onEngineStop(() => this.lastInput < this.lastFrame && this.frame(1400))
      .onNodeDrag((n: GNode) => {
        this.dragging = n.id;
        this.lastInput = performance.now();
        const t = this.findDrop(n);
        if (t !== this.dropTarget) {
          this.dropTarget = t;
          this.retarget();
        }
      })
      .onNodeDragEnd((n: GNode) => {
        const t = this.dropTarget;
        this.dragging = this.dropTarget = null;
        this.retarget();
        if (t) cb.onDrop(n.id, t);
      });

    // Forces: topics push apart, articles orbit their topic, cross-links pull gently.
    (this.g.d3Force('link') as any)
      .distance((l: GLink) => this.linkDistance(l))
      .strength((l: GLink) => (l.kind === 'cross' ? 0.015 : l.kind === 'root' ? 0.3 : 0.7));
    // Main topics push each other far apart, so each reads as its own cluster.
    (this.g.d3Force('charge') as any)
      .strength((n: GNode) =>
        n.kind === 'root' ? -20 : n.kind === 'topic' ? (n.depth === 1 ? -320 - n.r * 8 : -110 - n.r * 4) : -32,
      )
      .distanceMax(520);
    this.g.d3Force('collide', forceCollide((n: GNode) => n.r * 1.3 + 2).strength(0.75) as any);

    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.08,
      rotateSpeed: 0.55,
      zoomSpeed: 0.9,
      maxDistance: 5000,
      autoRotateSpeed: 0,
    });
    // 3d-force-graph fires a synthetic pointerup after a node drag; OrbitControls
    // throws on pointers it never saw. Ignore those.
    const ctl = this.controls as any;
    const onUp = ctl._onPointerUp;
    ctl._onPointerUp = (e: PointerEvent) => {
      if (!e.isTrusted && !ctl._pointers?.includes(e.pointerId)) return;
      onUp(e);
    };
    this.camera.far = 20000;
    this.g.cameraPosition({ x: 0, y: 40, z: 900 });

    const poke = () => (this.lastInput = performance.now());
    // Only touching the map counts; typing in a panel shouldn't stop the camera re-centering.
    el.addEventListener('pointerdown', poke);
    el.addEventListener('wheel', poke, { passive: true });

    this.ro = new ResizeObserver(() => this.g.width(el.clientWidth).height(el.clientHeight));
    this.ro.observe(el);
    this.raf = requestAnimationFrame(this.tick);
  }

  // ---------------------------------------------------------------- data

  sync(lib: Library, pending: ReadonlySet<string>) {
    const ids = new Set(lib.nodes.map((n) => n.id));
    const parentOf = new Map<string, string>();
    const kids = new Map<string, string[]>([[ROOT, []]]);
    for (const n of lib.nodes) {
      const p = n.parent && ids.has(n.parent) ? n.parent : ROOT;
      parentOf.set(n.id, p);
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p)!.push(n.id);
    }

    const depth = new Map<string, number>([[ROOT, 0]]);
    const depthOf = (id: string, guard = 0): number => {
      if (depth.has(id)) return depth.get(id)!;
      const d = guard > 64 ? 1 : depthOf(parentOf.get(id) ?? ROOT, guard + 1) + 1;
      depth.set(id, d);
      return d;
    };
    const size = new Map<string, number>();
    const sizeOf = (id: string, seen = new Set<string>()): number => {
      if (size.has(id)) return size.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const s = (kids.get(id) ?? []).reduce((acc, c) => acc + 1 + sizeOf(c, seen), 0);
      size.set(id, s);
      return s;
    };

    const neighbors = new Map<string, Set<string>>();
    for (const l of lib.links) {
      if (!ids.has(l.a) || !ids.has(l.b)) continue;
      if (!neighbors.has(l.a)) neighbors.set(l.a, new Set());
      if (!neighbors.has(l.b)) neighbors.set(l.b, new Set());
      neighbors.get(l.a)!.add(l.b);
      neighbors.get(l.b)!.add(l.a);
    }

    const next: GNode[] = [this.root];
    for (const n of lib.nodes) {
      let g = this.nodes.get(n.id);
      if (!g) {
        g = { id: n.id, kind: n.type, title: '', r: 1, depth: 1, hidden: false, annotated: false, pending: false, opT: 0, labT: 0, haloT: 0 };
        // New bubbles bud out of their parent.
        const p = this.nodes.get(parentOf.get(n.id)!) ?? this.root;
        if (p.x !== undefined && this.framedOnce) {
          const j = () => (Math.random() - 0.5) * 8;
          Object.assign(g, { x: p.x + j(), y: (p.y ?? 0) + j(), z: (p.z ?? 0) + j() });
        }
        this.nodes.set(n.id, g);
      }
      g.kind = n.type;
      g.title = n.title;
      g.depth = depthOf(n.id);
      g.hidden = !!n.hidden;
      g.pending = pending.has(n.id);
      g.annotated = n.type === 'article' && (n.highlights.length > 0 || !!n.summary?.trim());
      g.r =
        n.type === 'article'
          ? 4.2
          : Math.min(24, (g.depth <= 1 ? 13 : g.depth === 2 ? 9 : 7) + Math.sqrt(sizeOf(n.id)) * 1.3);
      this.paint(g);
      next.push(g);
    }
    for (const [id, g] of this.nodes) {
      if (!ids.has(id)) {
        // Detach the label object itself: removing only its parent leaves the HTML label on screen.
        g.v?.label.removeFromParent();
        g.v?.labelEl.remove();
        g.v?.mat.dispose();
        g.v?.haloMat.dispose();
        this.nodes.delete(id);
      }
    }

    const want = new Map<string, GLink>();
    const link = (id: string, kind: GLink['kind'], a: string, b: string, note?: string) => {
      const old = this.links.get(id);
      if (old && old.kind === kind && end(old.source) === a && end(old.target) === b) {
        old.note = note;
        want.set(id, old);
        return;
      }
      want.set(id, {
        id, kind, source: a, target: b, note, spark: false,
        mat: old?.mat ?? new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
        op: old?.op ?? 0,
        opT: 0,
      });
    };
    for (const n of lib.nodes) {
      const p = parentOf.get(n.id)!;
      link(`p:${n.id}`, p === ROOT ? 'root' : 'parent', p, n.id);
    }
    for (const l of lib.links) {
      if (ids.has(l.a) && ids.has(l.b) && l.a !== l.b) link(l.id, 'cross', l.a, l.b, l.note);
    }
    for (const [id, l] of this.links) if (!want.has(id)) l.mat.dispose();
    this.links = want;
    this.parentOf = parentOf;
    this.kids = kids;
    this.neighbors = neighbors;

    const sig =
      next.map((n) => n.id).join(',') +
      '|' +
      [...want.values()].map((l) => `${l.id}:${end(l.source)}>${end(l.target)}`).join(',');
    if (sig !== this.signature) {
      this.signature = sig;
      this.sparkSig = '';
      this.g.graphData({ nodes: next, links: [...want.values()] });
    }
    if (this.focus !== ROOT && !this.nodes.has(this.focus)) this.focus = ROOT;
    this.retarget();

    if (!this.framedOnce && lib.nodes.length) {
      this.framedOnce = true;
      this.introUntil = performance.now() + 1500;
      // Frame early, then again as the layout spreads out (unless you've moved the camera).
      setTimeout(() => this.frame(1800), 700);
      setTimeout(() => this.lastInput < this.lastFrame && this.frame(1600), 3200);
    }
  }

  // ---------------------------------------------------------------- view

  /** Which folder you're in and which article is open. Flies the camera when either changes. */
  setView(focus: string | null, selected: string | null, shiftX = 0, shiftY = 0) {
    const f = focus && this.nodes.has(focus) ? focus : ROOT;
    const moved = f !== this.focus || selected !== this.selected;
    this.focus = f;
    this.selected = selected;
    this.offsetT = selected ? { x: shiftX, y: shiftY } : { x: 0, y: 0 };
    this.retarget();
    if (moved && this.framedOnce) this.frame();
  }

  /** Highlights the bubble you're connecting from. */
  mark(id: string | null) {
    this.marked = id;
    this.retarget();
  }

  setPaused(p: boolean) {
    if (p === this.paused) return;
    this.paused = p;
    if (p) this.g.pauseAnimation();
    else {
      this.g.resumeAnimation();
      if (this.framedOnce) this.frame(900);
    }
  }

  frame(ms = 1100) {
    this.lastFrame = performance.now();
    if (this.selected && this.nodes.has(this.selected)) {
      const around = [...(this.neighbors.get(this.selected) ?? [])].map((id) => this.nodes.get(id)!);
      this.flyTo(this.nodes.get(this.selected)!, around, 42, 240, ms);
    } else {
      const center = this.focus === ROOT ? this.root : this.nodes.get(this.focus)!;
      const kids = (this.kids.get(this.focus) ?? []).map((id) => this.nodes.get(id)!).filter(Boolean);
      this.flyTo(center, kids, 55, 2600, ms);
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.g._destructor();
    this.el.innerHTML = '';
  }

  // ---------------------------------------------------------------- internals

  private handleClick(n: GNode, ev: MouseEvent) {
    if (n.kind === 'root') return;
    const t = performance.now();
    if (this.lastClick.id === n.id && t - this.lastClick.t < 340) {
      this.lastClick = { id: '', t: 0 };
      this.cb.onDblClick(n.id);
    } else {
      this.lastClick = { id: n.id, t };
      this.cb.onClick(n.id, ev);
    }
  }

  private linkDistance(l: GLink) {
    const a = l.source as GNode;
    const b = l.target as GNode;
    if (l.kind === 'root') return 80 + b.r * 5;
    if (l.kind === 'cross') return 90;
    return a.r + b.r + (b.kind === 'topic' ? 28 : 11);
  }

  /** The topic bubble the dragged bubble is over, judged on screen (what you see), not in 3D depth. */
  private findDrop(n: GNode): string | null {
    if (n.x === undefined) return null;
    const h = this.el.clientHeight;
    const k = h / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const at = this.g.graph2ScreenCoords(n.x, n.y ?? 0, n.z ?? 0);
    let best: string | null = null;
    let bestScore = Infinity;
    for (const m of this.nodes.values()) {
      if (m.kind !== 'topic' || m.id === n.id || m.id === this.parentOf.get(n.id) || m.x === undefined) continue;
      // can't drop a topic into its own sub-topics
      let c: string | undefined = m.id;
      let inside = false;
      for (let i = 0; c && c !== ROOT && i < 64; i++, c = this.parentOf.get(c)) if (c === n.id) inside = true;
      if (inside) continue;
      const p = this.g.graph2ScreenCoords(m.x, m.y ?? 0, m.z ?? 0);
      const depth = this.camera.position.distanceTo(new THREE.Vector3(m.x, m.y, m.z));
      const rPx = (m.r / Math.max(depth, 1)) * k;
      const d = Math.hypot(at.x - p.x, at.y - p.y);
      const score = d / (rPx + 12);
      if (score < 1 && score < bestScore) {
        best = m.id;
        bestScore = score;
      }
    }
    return best;
  }

  private flyTo(center: GNode, others: GNode[], minD: number, maxD: number, ms: number) {
    if (center.x === undefined) return;
    const c = new THREE.Vector3(center.x, center.y, center.z);
    let R = center.r * 1.6;
    for (const o of others) {
      if (o?.x !== undefined) R = Math.max(R, c.distanceTo(new THREE.Vector3(o.x, o.y, o.z)) + o.r * 1.6 + 6);
    }
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const narrow = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const dist = THREE.MathUtils.clamp((R / Math.sin(narrow / 2)) * 1.02, minD, maxD);
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const pos = c.clone().addScaledVector(dir, dist);
    this.g.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: c.x, y: c.y, z: c.z }, ms);
  }

  private objectFor(n: GNode): THREE.Object3D {
    if (n.kind === 'root') return new THREE.Object3D();
    const topic = n.kind === 'topic';
    const mat = topic ? bubbleMaterial({ fill: 0, rim: 1, spec: 1, base: 0.03 }) : bubbleMaterial({ fill: 1, rim: 0 });
    const mesh = new THREE.Mesh(GEO, mat);
    const haloMat = bubbleMaterial({ fill: 0, rim: 1.2, spec: 0, base: 0, additive: true });
    const haloMesh = new THREE.Mesh(GEO, haloMat);
    haloMesh.scale.setScalar(topic ? 1.3 : 1.9);
    haloMesh.raycast = () => {};
    haloMesh.visible = false;
    mesh.add(haloMesh);

    const labelEl = document.createElement('div');
    labelEl.className = `nlabel ${n.kind}`;
    const text = document.createElement('span');
    labelEl.appendChild(text);
    const label = new CSS2DObject(labelEl);
    label.position.set(0, -1.35, 0);
    mesh.add(label);

    const group = new THREE.Group();
    group.add(mesh);
    n.v = {
      group, mesh, mat, haloMesh, haloMat, label, labelEl, text,
      born: performance.now() + (performance.now() < this.introUntil ? 250 + n.depth * 170 + Math.random() * 280 : 0),
      phase: Math.random() * Math.PI * 2,
      s: 0, sv: 0, op: 0, lab: 0, labShown: -1, halo: 0,
    };
    this.paint(n);
    return group;
  }

  private paint(n: GNode) {
    const v = n.v;
    if (!v) return;
    const t = shorten(n.title || 'Untitled') + (n.pending ? '  ···' : '');
    if (v.text.textContent !== t) v.text.textContent = t;
    v.labelEl.classList.toggle('private', n.hidden);
    if (n.kind === 'article') v.mat.uniforms.uBright.value = n.annotated ? 1 : 0.6;
  }

  /** Recomputes how bright each bubble, label and line should be. */
  private retarget() {
    const f = this.focus;
    const sel = this.selected && this.nodes.has(this.selected) ? this.selected : null;
    const hov = this.hover;
    const rel = (id: string) => {
      let c: string | undefined = id;
      for (let d = 0; c && d < 64; d++, c = this.parentOf.get(c)) if (c === f) return d;
      return -1;
    };
    const ancestors = new Set<string>();
    for (let c = this.parentOf.get(f); c && c !== ROOT && !ancestors.has(c); c = this.parentOf.get(c)) ancestors.add(c);

    const depthBelow = new Map<string, number>();
    const reach = new Set<string>();
    for (const id of this.nodes.keys()) {
      const d = rel(id);
      depthBelow.set(id, d);
      if (d === 0 || d === 1) for (const o of this.neighbors.get(id) ?? []) reach.add(o);
    }
    const selN = sel ? this.neighbors.get(sel) : undefined;
    const hovN = hov ? this.neighbors.get(hov) : undefined;
    const base = new Map<string, number>();

    for (const n of this.nodes.values()) {
      const d = depthBelow.get(n.id)!;
      let op: number;
      let lab: boolean;
      if (d === 0) [op, lab] = [0.8, true];
      else if (d === 1) [op, lab] = [1, true];
      else if (d === 2) [op, lab] = [0.5, false]; // one level of labels at a time; hover shows the rest
      else if (d > 2) [op, lab] = [0.26, false];
      else if (ancestors.has(n.id)) [op, lab] = [0.38, true];
      else if (reach.has(n.id)) [op, lab] = [0.6, true];
      else [op, lab] = [0.12, false];
      if (sel) {
        if (n.id === sel || selN?.has(n.id)) [op, lab] = [1, true];
        else if (d !== 0) op *= 0.65;
      }
      base.set(n.id, op);
      if (n.id === hov || hovN?.has(n.id)) [op, lab] = [Math.max(op, 0.9), true];
      if (n.hidden) op *= 0.55;
      n.opT = op;
      n.labT = lab ? 1 : 0;
      n.haloT = n.id === this.dropTarget ? 1 : n.id === this.marked ? 0.8 : n.id === sel ? 0.5 : 0;
    }

    const opOf = (e: string | GNode) => this.nodes.get(end(e))?.opT ?? 0;
    const baseOf = (e: string | GNode) => base.get(end(e)) ?? 0;
    let spark = '';
    for (const l of this.links.values()) {
      if (l.kind === 'root') {
        l.opT = 0;
        continue;
      }
      const touches = (id: string | null) => !!id && (end(l.source) === id || end(l.target) === id);
      if (l.kind === 'cross') {
        l.opT = touches(sel) || touches(hov) ? 0.95 : 0.7 * Math.min(opOf(l.source), opOf(l.target));
        l.spark = Math.min(baseOf(l.source), baseOf(l.target)) >= 0.5 || touches(sel);
        if (l.spark) spark += l.id + ',';
      } else {
        l.opT = 0.32 * Math.min(opOf(l.source), opOf(l.target));
      }
    }
    // Little particles drift along connections you're looking at.
    if (spark !== this.sparkSig) {
      this.sparkSig = spark;
      this.g.linkDirectionalParticles((l: GLink) => (l.spark ? 2 : 0));
    }
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.paused) return;
    const time = now / 1000;
    const camDist = this.camera.position.distanceTo(this.controls.target);
    shared.uFogNear.value = this.fog.near = camDist * 1.3;
    shared.uFogFar.value = this.fog.far = camDist * 3.6;
    const camPos = this.camera.position;

    for (const n of this.nodes.values()) {
      const v = n.v;
      if (!v) continue;
      // springy scale: grows in, swells on hover / drop target
      const target = now < v.born ? 0 : n.id === this.hover || n.id === this.dropTarget ? 1.15 : 1;
      v.sv = (v.sv + (target - v.s) * 0.13) * 0.7;
      v.s += v.sv;
      const pulse = n.pending ? 1 + Math.sin(time * 6) * 0.07 : 1;
      v.mesh.scale.setScalar(Math.max(1e-4, n.r * v.s * pulse));
      v.mesh.position.y = Math.sin(time * 0.8 + v.phase) * n.r * 0.07;

      v.op += (n.opT - v.op) * 0.08;
      v.mat.uniforms.uOpacity.value = v.op;

      v.halo += (n.haloT * (0.8 + 0.2 * Math.sin(time * 3)) - v.halo) * 0.14;
      v.haloMesh.visible = v.halo > 0.01;
      v.haloMat.uniforms.uOpacity.value = v.halo;

      v.lab += (n.labT - v.lab) * 0.12;
      const dist = camPos.distanceTo(v.group.position);
      const shown = v.lab * (1 - smooth(camDist * 1.2, camDist * 2.2, dist)) * Math.min(1, v.op * 1.5) * Math.min(1, v.s);
      if (Math.abs(shown - v.labShown) > 0.01) {
        v.labShown = shown;
        v.labelEl.style.opacity = shown.toFixed(2);
        v.labelEl.style.visibility = shown < 0.02 ? 'hidden' : 'visible';
      }
    }
    for (const l of this.links.values()) {
      l.op += (l.opT - l.op) * 0.08;
      l.mat.opacity = l.op;
      l.mat.visible = l.op > 0.004;
    }

    // Shift the scene out from under the article card (left on desktop, up on phones).
    const o = this.offset;
    const dx = (this.offsetT.x - o.x) * 0.1;
    const dy = (this.offsetT.y - o.y) * 0.1;
    if (Math.abs(dx) + Math.abs(dy) > 0.05) {
      o.x += dx;
      o.y += dy;
      const w = this.el.clientWidth;
      const h = this.el.clientHeight;
      if (Math.abs(o.x) + Math.abs(o.y) < 0.5) this.camera.clearViewOffset();
      else this.camera.setViewOffset(w, h, o.x, o.y, w, h);
    }

    // Drift slowly when nobody's touching anything.
    const idle = now - this.lastInput > 9000 && !this.selected && !this.dragging;
    this.controls.autoRotateSpeed += ((idle ? 0.3 : 0) - this.controls.autoRotateSpeed) * 0.02;
    this.controls.autoRotate = this.controls.autoRotateSpeed > 0.004;
  };
}
