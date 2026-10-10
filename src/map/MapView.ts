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
  /** Has bookmarks: its label carries a red ribbon. */
  marked?: boolean;
  /** Held at a spot (edit screen). */
  pin?: [number, number, number];
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
  // The edit screen only:
  /** A line was clicked. Parent lines are `p:<child id>`, connections their own id. */
  onLinkClick?(id: string, ev: MouseEvent): void;
  /** The + in the middle of a line was clicked. */
  onLinkInsert?(id: string, x: number, y: number): void;
  /** One end of a line was dragged onto a bubble (null: let go over nothing). */
  onLinkEnd?(id: string, which: 'a' | 'b', target: string | null): void;
  /** The dot on a bubble was dragged onto another one. */
  onConnect?(a: string, b: string): void;
  /** A bubble was dropped in open space and stays there. */
  onPin?(id: string, at: [number, number, number]): void;
  onBackgroundDbl?(x: number, y: number): void;
}

type Pt = { x: number; y: number };
const segDist = (px: number, py: number, a: Pt, b: Pt) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
};
const round1 = (v = 0) => Math.round(v * 10) / 10;

const GEO = new THREE.SphereGeometry(1, 48, 32);
const end = (e: string | GNode) => (typeof e === 'string' ? e : e.id);
const shorten = (s: string, n = 44) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** How far a bubble's connections pull it from its parent toward the middle
 * of what it is connected to: 10% per connection, so five put it halfway,
 * then 3% more for each one after that, stopping at 65%. Its parent always
 * keeps the larger share. */
export const pullShare = (connections: number, strength = 1) =>
  Math.min(0.65, (connections <= 5 ? 0.1 * connections : 0.5 + 0.03 * (connections - 5)) * strength);

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
  /* Each bubble's connections other than its own parent: what pulls it off its parent. */
  private pulls = new Map<string, string[]>();

  private focus = ROOT;
  private selected: string | null = null;
  private hover: string | null = null;
  private dropTarget: string | null = null;
  private dragging: string | null = null;
  private marked: string | null = null;

  private offset = { x: 0, y: 0 };
  private offsetT = { x: 0, y: 0 };
  private lastClick = { id: '', t: 0 };
  /* Our own click and hover handling (see listen()). */
  private press: { x: number; y: number; t: number; button: number } | null = null;
  private rightMoved = false;
  private pointer = { x: 0, y: 0, inside: false };
  private hoverDirty = false;
  /* Our own camera flights, so touching the map can cancel one mid-air. */
  private flight: {
    p0: THREE.Vector3;
    t0: THREE.Vector3;
    p1: THREE.Vector3;
    t1: THREE.Vector3;
    start: number;
    dur: number;
  } | null = null;
  private lastInput = performance.now();
  /* Moving the mouse over the map pauses the idle drift, so a bubble you're
   * aiming at doesn't slide away. */
  private lastPointer = 0;
  private lastFrame = 0;
  private framedOnce = false;
  private introUntil = 0;
  private paused = false;
  private raf = 0;
  private ro: ResizeObserver;
  private viewShift = { x: 0, y: 0 };

  /* The edit screen: everything shown, bubbles and lines selectable, handles
   * on whatever is selected. */
  private editing = false;
  private editNode: string | null = null;
  private editLink: string | null = null;
  private connectFrom: string | null = null;
  private hoverLink: string | null = null;
  private editTarget: string | null = null;
  private handle: { kind: 'end' | 'connect'; link?: string; which?: 'a' | 'b'; from: string } | null = null;
  private plusFor: string | null = null;
  private lastBg = { t: 0, x: 0, y: 0 };
  /** px of the map the edit screen's side panels cover, left and right */
  private insets = { left: 0, right: 0 };
  private ov: {
    root: HTMLDivElement;
    hover: SVGLineElement;
    sel: SVGLineElement;
    rubber: SVGLineElement;
    plus: HTMLButtonElement;
    ends: [HTMLDivElement, HTMLDivElement];
    dot: HTMLDivElement;
  } | null = null;
  private settings = { spacing: 1, pull: 1 };
  private spawn = new Map<string, { x: number; y: number; z: number }>();
  private drift = (() => {
    try {
      return localStorage.getItem('drift') !== 'off';
    } catch {
      return true;
    }
  })();

  constructor(private el: HTMLElement, private cb: MapCallbacks, editable: boolean) {
    const labels = new CSS2DRenderer();
    labels.domElement.className = 'labels';
    // Re-sorting every label's z-index every frame was most of the map's lag.
    labels.sortObjects = false;

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
      .showPointerCursor(false)
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
        if (t) return cb.onDrop(n.id, t);
        if (this.editing && n.x !== undefined) {
          // Let go in open space while editing: it stays where you put it.
          const at: [number, number, number] = [round1(n.x), round1(n.y), round1(n.z)];
          [n.fx, n.fy, n.fz] = at;
          n.pin = at;
          cb.onPin?.(n.id, at);
        } else if (n.pin) [n.fx, n.fy, n.fz] = n.pin;
      });

    this.applyForces();
    this.g.d3Force('pull', this.pullForce() as any);
    this.g.d3Force('collide', forceCollide((n: GNode) => n.r * 1.3 + 2).strength(0.75) as any);

    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.14,
      rotateSpeed: 0.7,
      zoomSpeed: 1.15,
      // Scroll zooms toward whatever is under the pointer, not the middle of the screen.
      zoomToCursor: true,
      minDistance: 6,
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

    this.listen();
    if (editable) this.buildOverlay();

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
    let repin = false;
    for (const n of lib.nodes) {
      let g = this.nodes.get(n.id);
      if (!g) {
        g = { id: n.id, kind: n.type, title: '', r: 1, depth: 1, hidden: false, annotated: false, pending: false, opT: 0, labT: 0, haloT: 0 };
        // New bubbles bud out of their parent, or appear where they were made.
        const p = this.nodes.get(parentOf.get(n.id)!) ?? this.root;
        const at = this.spawn.get(n.id);
        if (at) {
          Object.assign(g, at);
          this.spawn.delete(n.id);
        } else if (p.x !== undefined && this.framedOnce) {
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
      g.marked = n.type === 'article' && !!n.bookmarks?.length;
      // Pinned in the edit screen: held there (unless it's being dragged right now).
      if (this.dragging !== n.id) {
        const pin = n.pin;
        if (pin) {
          if (g.fx !== pin[0] || g.fy !== pin[1] || g.fz !== pin[2]) {
            [g.fx, g.fy, g.fz] = pin;
            if (g.x === undefined) [g.x, g.y, g.z] = pin;
            repin = true;
          }
        } else if (g.pin) {
          delete g.fx;
          delete g.fy;
          delete g.fz;
          repin = true;
        }
        g.pin = pin;
      }
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
    this.pulls = new Map(
      [...neighbors].map(([id, set]) => [id, [...set].filter((o) => o !== parentOf.get(id))] as [string, string[]]),
    );

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

    const settings = {
      spacing: Math.min(2, Math.max(0.5, lib.settings?.spacing ?? 1)),
      pull: Math.min(2, Math.max(0, lib.settings?.pull ?? 1)),
    };
    const relayout = settings.spacing !== this.settings.spacing || settings.pull !== this.settings.pull;
    if (relayout) {
      this.settings = settings;
      this.applyForces();
    }
    if ((relayout || repin) && this.framedOnce) this.g.d3ReheatSimulation();
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
    this.viewShift = { x: shiftX, y: shiftY };
    if (!this.editing) this.offsetT = selected ? { x: shiftX, y: shiftY } : { x: 0, y: 0 };
    this.retarget();
    if (moved && this.framedOnce && !this.editing) this.frame();
  }

  // ---------------------------------------------------------------- edit screen

  /** Turns the edit screen on or off, and says what's selected in it. */
  setEdit(on: boolean, node: string | null, link: string | null, connectFrom: string | null, left = 0, right = 0) {
    const entering = on && !this.editing;
    const leaving = !on && this.editing;
    this.editing = on;
    this.editNode = node;
    this.editLink = link;
    this.connectFrom = connectFrom;
    this.insets = on ? { left, right } : { left: 0, right: 0 };
    // Centre the map in the space between the panels.
    if (on) this.offsetT = { x: (right - left) / 2, y: 0 };
    else {
      this.hoverLink = this.editTarget = this.handle = null;
      if (leaving) this.offsetT = this.selected ? { ...this.viewShift } : { x: 0, y: 0 };
    }
    this.el.classList.toggle('editing', on);
    this.el.style.cursor = connectFrom ? 'crosshair' : '';
    this.retarget();
    this.drawOverlay();
    if (entering && this.framedOnce) this.frameAll(900);
    if (leaving && this.framedOnce) this.frame(900);
  }

  /** The whole map in view. */
  frameAll(ms = 800) {
    const all = [...this.nodes.values()].filter((n) => n.x !== undefined);
    if (!all.length) return;
    // Around the middle of the bubbles themselves, not the map's origin.
    const c = { x: 0, y: 0, z: 0 };
    for (const n of all) {
      c.x += n.x! / all.length;
      c.y += (n.y ?? 0) / all.length;
      c.z += (n.z ?? 0) / all.length;
    }
    this.lastFrame = performance.now();
    this.flyTo({ ...this.root, ...c, r: 0 }, all, 60, 8000, ms, 0.92);
  }

  /** One bubble and what's around it in view. */
  frameNode(id: string, ms = 700) {
    const n = this.nodes.get(id);
    if (!n) return;
    const around = [...(this.neighbors.get(id) ?? []), ...(this.kids.get(id) ?? [])]
      .map((x) => this.nodes.get(x)!)
      .filter(Boolean);
    this.lastFrame = performance.now();
    this.flyTo(n, around, 40, 900, ms, 1.15);
  }

  /** Where the next bubble with this id should appear. */
  spawnAt(id: string, at: { x: number; y: number; z: number } | null | undefined) {
    if (at) this.spawn.set(id, at);
  }

  /** The middle of a line, in the map's space. */
  midpointOf(linkId: string) {
    const l = this.links.get(linkId);
    const a = l?.source as GNode | undefined;
    const b = l?.target as GNode | undefined;
    if (!a || !b || a.x === undefined || b.x === undefined) return null;
    return { x: (a.x + b.x) / 2, y: ((a.y ?? 0) + (b.y ?? 0)) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 };
  }

  /** The point in the map under a screen point, level with what you're looking at. */
  worldAt(clientX: number, clientY: number) {
    const rect = this.el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), this.controls.target);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? { x: out.x, y: out.y, z: out.z } : null;
  }

  /** The slow spin when nothing's touched. */
  setDrift(on: boolean) {
    this.drift = on;
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

  frame(ms = 700) {
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

  /** Clicks, right-clicks and hover, handled here rather than by 3d-force-graph:
   * a press that moves under 6px is a click, and what it hit is worked out
   * right then from where the bubbles are on screen. */
  private listen() {
    const el = this.el;
    // Touching the map stops any flight and counts as input; typing in a panel doesn't.
    const touch = () => {
      this.lastInput = performance.now();
      this.flight = null;
    };
    el.addEventListener('pointerdown', (e) => {
      touch();
      this.press = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
    });
    el.addEventListener('wheel', touch, { passive: true });
    el.addEventListener('pointerup', (e) => {
      const p = this.press;
      this.press = null;
      this.hoverDirty = true;
      if (!p || p.button !== e.button) return;
      const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6;
      if (e.button === 2) this.rightMoved = moved;
      if (e.button !== 0 || moved || performance.now() - p.t > 800) return;
      const id = this.pick(e.clientX, e.clientY);
      if (id) return this.handleClick(id, e);
      const link = this.editing ? this.pickLink(e.clientX, e.clientY) : null;
      if (link) return this.cb.onLinkClick?.(link, e);
      const t = performance.now();
      if (this.editing && t - this.lastBg.t < 340 && Math.hypot(e.clientX - this.lastBg.x, e.clientY - this.lastBg.y) < 12) {
        this.lastBg = { t: 0, x: 0, y: 0 };
        return this.cb.onBackgroundDbl?.(e.clientX, e.clientY);
      }
      this.lastBg = { t, x: e.clientX, y: e.clientY };
      this.cb.onBackground();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.rightMoved) return (this.rightMoved = false); // that was a pan
      const id = this.pick(e.clientX, e.clientY);
      if (id) return this.cb.onRightClick(id, e);
      const link = this.editing ? this.pickLink(e.clientX, e.clientY) : null;
      if (link) this.cb.onLinkClick?.(link, e);
    });
    el.addEventListener('pointermove', (e) => {
      this.lastPointer = performance.now();
      this.pointer = { x: e.clientX, y: e.clientY, inside: true };
      this.hoverDirty = true;
    });
    el.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      this.hoverDirty = true;
    });
  }

  /** The bubble under a screen point. Pearls win over the glass bubbles around
   * them; small or far ones get a few pixels of slack so they can still be hit. */
  private pick(clientX: number, clientY: number): string | null {
    const rect = this.el.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const k = rect.height / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const at = new THREE.Vector3();
    let best: string | null = null;
    let bestScore = Infinity;
    for (const n of this.nodes.values()) {
      const v = n.v;
      if (!v || n.kind === 'root') continue;
      v.mesh.getWorldPosition(at);
      const dist = at.distanceTo(this.camera.position);
      at.project(this.camera);
      if (at.z < -1 || at.z > 1) continue;
      const sx = ((at.x + 1) / 2) * rect.width;
      const sy = ((1 - at.y) / 2) * rect.height;
      const radius = ((n.r * Math.max(v.s, 0.2)) / Math.max(dist, 1)) * k;
      const reach = Math.max(radius * 1.08, n.kind === 'article' ? 11 : 9);
      if (Math.hypot(sx - px, sy - py) > reach) continue;
      const score = (n.kind === 'article' ? 0 : 1e7) + dist;
      if (score < bestScore) {
        best = n.id;
        bestScore = score;
      }
    }
    return best;
  }

  /** Screen position (px inside the map) of a point in the map; null behind the camera. */
  private screenOf(x = 0, y = 0, z = 0): Pt | null {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z < -1 || v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * this.el.clientWidth, y: ((1 - v.y) / 2) * this.el.clientHeight };
  }

  /** The part of a line you can see, between the two bubbles' surfaces, on screen. */
  private lineOnScreen(l: GLink) {
    const a = l.source as GNode;
    const b = l.target as GNode;
    if (typeof a !== 'object' || typeof b !== 'object' || a.x === undefined || b.x === undefined) return null;
    const A = new THREE.Vector3(a.x, a.y, a.z);
    const B = new THREE.Vector3(b.x, b.y, b.z);
    const len = A.distanceTo(B);
    const ra = a.r * Math.max(a.v?.s ?? 1, 0.2);
    const rb = b.r * Math.max(b.v?.s ?? 1, 0.2);
    if (len < ra + rb + 0.5) return null;
    const dir = B.clone().sub(A).divideScalar(len);
    const pa = A.clone().addScaledVector(dir, ra);
    const pb = B.clone().addScaledVector(dir, -rb);
    const sa = this.screenOf(pa.x, pa.y, pa.z);
    const sb = this.screenOf(pb.x, pb.y, pb.z);
    if (!sa || !sb) return null;
    return { a: sa, b: sb, mid: { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 } };
  }

  /** The line under a screen point (bubbles are checked first). */
  private pickLink(clientX: number, clientY: number): string | null {
    const rect = this.el.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best: string | null = null;
    let bestD = 7;
    for (const l of this.links.values()) {
      if (l.kind === 'root' || l.op < 0.05) continue;
      const s = this.lineOnScreen(l);
      if (!s) continue;
      const d = segDist(px, py, s.a, s.b);
      if (d < bestD) {
        bestD = d;
        best = l.id;
      }
    }
    return best;
  }

  private buildOverlay() {
    const NS = 'http://www.w3.org/2000/svg';
    const root = document.createElement('div');
    root.className = 'edit-ov';
    root.style.display = 'none';
    const svg = document.createElementNS(NS, 'svg');
    svg.classList.add('edit-svg');
    const line = (cls: string) => {
      const l = document.createElementNS(NS, 'line');
      l.classList.add(cls);
      svg.appendChild(l);
      return l;
    };
    const hover = line('ln-hover');
    const sel = line('ln-sel');
    const rubber = line('ln-rubber');
    root.appendChild(svg);

    const plus = document.createElement('button');
    plus.className = 'ln-plus';
    plus.textContent = '+';
    plus.title = 'Add a bubble here';
    // The overlay's buttons are not clicks on the map behind them.
    for (const t of ['pointerdown', 'pointerup', 'dblclick'] as const) plus.addEventListener(t, (e) => e.stopPropagation());
    plus.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.plusFor) this.cb.onLinkInsert?.(this.plusFor, e.clientX, e.clientY);
    });
    root.appendChild(plus);

    const mkEnd = (which: 'a' | 'b') => {
      const d = document.createElement('div');
      d.className = 'ln-end';
      d.title = 'Drag onto another bubble';
      d.addEventListener('pointerdown', (e) => this.startHandle(e, 'end', which));
      root.appendChild(d);
      return d;
    };
    const ends: [HTMLDivElement, HTMLDivElement] = [mkEnd('a'), mkEnd('b')];

    const dot = document.createElement('div');
    dot.className = 'node-dot';
    dot.title = 'Drag onto another bubble to connect them';
    dot.addEventListener('pointerdown', (e) => this.startHandle(e, 'connect'));
    root.appendChild(dot);

    this.el.appendChild(root);
    this.ov = { root, hover, sel, rubber, plus, ends, dot };
  }

  /** Dragging a line's end, or a bubble's connect dot, onto another bubble. */
  private startHandle(e: PointerEvent, kind: 'end' | 'connect', which?: 'a' | 'b') {
    e.stopPropagation();
    e.preventDefault();
    let from: string;
    if (kind === 'end') {
      const l = this.editLink ? this.links.get(this.editLink) : undefined;
      if (!l) return;
      // The end you hold moves; the other stays put.
      from = which === 'a' ? end(l.target) : end(l.source);
      this.handle = { kind, link: l.id, which, from };
    } else {
      if (!this.editNode) return;
      from = this.editNode;
      this.handle = { kind, from };
    }
    this.lastInput = performance.now();
    this.pointer = { x: e.clientX, y: e.clientY, inside: true };
    const over = (x: number, y: number) => {
      const t = this.pick(x, y);
      return t && t !== from ? t : null;
    };
    const move = (ev: PointerEvent) => {
      this.pointer = { x: ev.clientX, y: ev.clientY, inside: true };
      const t = over(ev.clientX, ev.clientY);
      if (t !== this.editTarget) {
        this.editTarget = t;
        this.retarget();
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const h = this.handle;
      const target = over(ev.clientX, ev.clientY);
      this.handle = this.editTarget = null;
      this.retarget();
      if (!h) return;
      if (h.kind === 'end') this.cb.onLinkEnd?.(h.link!, h.which!, target);
      else if (target) this.cb.onConnect?.(h.from, target);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Draws the edit screen's lines and handles where the map is right now. */
  private drawOverlay() {
    const ov = this.ov;
    if (!ov) return;
    ov.root.style.display = this.editing ? '' : 'none';
    if (!this.editing) return;
    const setLine = (ln: SVGLineElement, a?: Pt | null, b?: Pt | null) => {
      if (!a || !b) {
        ln.style.display = 'none';
        return;
      }
      ln.style.display = '';
      ln.setAttribute('x1', a.x.toFixed(1));
      ln.setAttribute('y1', a.y.toFixed(1));
      ln.setAttribute('x2', b.x.toFixed(1));
      ln.setAttribute('y2', b.y.toFixed(1));
    };
    const place = (el: HTMLElement, p: Pt | null | undefined) => {
      if (!p) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.left = `${p.x.toFixed(1)}px`;
      el.style.top = `${p.y.toFixed(1)}px`;
    };
    const holding = this.handle;
    const selL = this.editLink ? this.links.get(this.editLink) : undefined;
    const selS = selL ? this.lineOnScreen(selL) : null;
    const hovL = this.hoverLink && this.hoverLink !== this.editLink ? this.links.get(this.hoverLink) : undefined;
    const hovS = hovL && !holding ? this.lineOnScreen(hovL) : null;

    setLine(ov.hover, hovS?.a, hovS?.b);
    // While an end is held, the line follows the pointer instead.
    setLine(ov.sel, holding?.kind === 'end' ? null : selS?.a, selS?.b);
    const plusLine = hovS ? hovL : selS ? selL : undefined;
    this.plusFor = holding ? null : (plusLine?.id ?? null);
    place(ov.plus, holding ? null : (hovS?.mid ?? selS?.mid));
    place(ov.ends[0], !holding ? selS?.a : null);
    // A parent line's child end stays: it's the child's place. Its topic end moves.
    place(ov.ends[1], !holding && selL?.kind === 'cross' ? selS?.b : null);

    const n = this.editNode ? this.nodes.get(this.editNode) : undefined;
    let dotAt: Pt | null = null;
    if (n && n.x !== undefined && !holding && !this.connectFrom) {
      const c = this.screenOf(n.x, n.y, n.z);
      if (c) {
        const k = this.el.clientHeight / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
        const dist = this.camera.position.distanceTo(new THREE.Vector3(n.x, n.y, n.z));
        const r = ((n.r * Math.max(n.v?.s ?? 1, 0.2)) / Math.max(dist, 1)) * k;
        const o = Math.max(r * 0.72, 7) + 9;
        dotAt = { x: c.x + o, y: c.y - o };
      }
    }
    place(ov.dot, dotAt);

    const anchor = holding ? holding.from : this.connectFrom;
    const m = anchor ? this.nodes.get(anchor) : undefined;
    const from = m && m.x !== undefined && this.pointer.inside ? this.screenOf(m.x, m.y, m.z) : null;
    const rect = this.el.getBoundingClientRect();
    setLine(ov.rubber, from, from ? { x: this.pointer.x - rect.left, y: this.pointer.y - rect.top } : null);
  }

  private handleClick(id: string, ev: MouseEvent) {
    const t = performance.now();
    if (this.lastClick.id === id && t - this.lastClick.t < 340) {
      this.lastClick = { id: '', t: 0 };
      this.cb.onDblClick(id);
    } else {
      this.lastClick = { id, t };
      this.cb.onClick(id, ev);
    }
  }

  /** Pulls each connected bubble toward the point a pullShare() of the way
   * from its parent to the middle of what it is connected to. */
  private pullForce() {
    let nodes: GNode[] = [];
    const force = (alpha: number) => {
      const k = 0.45 * alpha;
      for (const n of nodes) {
        const others = this.pulls.get(n.id);
        if (!others?.length || n.x === undefined) continue;
        const parent = this.nodes.get(this.parentOf.get(n.id) ?? '') ?? this.root;
        if (parent.x === undefined) continue;
        let cx = 0;
        let cy = 0;
        let cz = 0;
        let c = 0;
        for (const id of others) {
          const o = this.nodes.get(id);
          if (o?.x === undefined) continue;
          cx += o.x;
          cy += o.y ?? 0;
          cz += o.z ?? 0;
          c++;
        }
        if (!c) continue;
        const f = pullShare(c, this.settings.pull);
        if (f <= 0) continue;
        const py = parent.y ?? 0;
        const pz = parent.z ?? 0;
        const tx = parent.x + f * (cx / c - parent.x);
        const ty = py + f * (cy / c - py);
        const tz = pz + f * (cz / c - pz);
        const m = n as GNode & { vx?: number; vy?: number; vz?: number };
        m.vx = (m.vx ?? 0) + (tx - n.x) * k;
        m.vy = (m.vy ?? 0) + (ty - (n.y ?? 0)) * k;
        m.vz = (m.vz ?? 0) + (tz - (n.z ?? 0)) * k;
      }
    };
    force.initialize = (ns: GNode[]) => {
      nodes = ns;
    };
    return force;
  }

  /** Topics push apart, articles orbit their topic, connections pull (see
   * pullForce). Spacing from the edit screen scales all of it. */
  private applyForces() {
    const sp = this.settings.spacing;
    (this.g.d3Force('link') as any)
      .distance((l: GLink) => this.linkDistance(l) * sp)
      .strength((l: GLink) => {
        if (l.kind === 'cross') return 0;
        const pulled = this.settings.pull > 0 && (this.pulls.get(end(l.target))?.length ?? 0) > 0;
        return pulled ? 0.01 : l.kind === 'root' ? 0.3 : 0.7;
      });
    // Main topics push each other far apart, so each reads as its own cluster.
    (this.g.d3Force('charge') as any)
      .strength(
        (n: GNode) =>
          sp * (n.kind === 'root' ? -20 : n.kind === 'topic' ? (n.depth === 1 ? -320 - n.r * 8 : -110 - n.r * 4) : -32),
      )
      .distanceMax(520 * sp);
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

  private flyTo(center: GNode, others: GNode[], minD: number, maxD: number, ms: number, margin = 1) {
    if (center.x === undefined) return;
    const c = new THREE.Vector3(center.x, center.y, center.z);
    let R = center.r * 1.6;
    for (const o of others) {
      if (o?.x !== undefined) R = Math.max(R, c.distanceTo(new THREE.Vector3(o.x, o.y, o.z)) + o.r * 1.6 + 6);
    }
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    // Only the part of the screen the panels leave open counts as width.
    const w = this.el.clientWidth || 1;
    const open = Math.max(0.3, (w - this.insets.left - this.insets.right) / w);
    const narrow = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect * open));
    const dist = THREE.MathUtils.clamp((R / Math.sin(narrow / 2)) * 1.02 * margin, minD, maxD);
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const pos = c.clone().addScaledVector(dir, dist);
    this.flight = {
      p0: this.camera.position.clone(),
      t0: this.controls.target.clone(),
      p1: pos,
      t1: c,
      start: performance.now(),
      dur: ms,
    };
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
    v.labelEl.classList.toggle('marked', !!n.marked);
    if (n.kind === 'article') v.mat.uniforms.uBright.value = n.annotated ? 1 : 0.6;
  }

  /** Recomputes how bright each bubble, label and line should be. */
  private retarget() {
    if (this.editing) return this.retargetEdit();
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

  /** Editing: every bubble and label in view; what's selected and what touches it stand out. */
  private retargetEdit() {
    const sel = this.editNode && this.nodes.has(this.editNode) ? this.editNode : null;
    const selN = sel ? this.neighbors.get(sel) : undefined;
    const selL = this.editLink ? this.links.get(this.editLink) : undefined;
    const ends = selL ? [end(selL.source), end(selL.target)] : [];
    const focused = !!(sel || selL);
    for (const n of this.nodes.values()) {
      let op = n.kind === 'topic' ? 0.9 : 1;
      if (focused) {
        const near =
          n.id === sel ||
          selN?.has(n.id) ||
          (sel && (this.parentOf.get(n.id) === sel || this.parentOf.get(sel) === n.id)) ||
          ends.includes(n.id);
        if (!near) op *= 0.5;
      }
      if (n.id === this.hover || n.id === this.editTarget || n.id === this.connectFrom) op = 1;
      if (n.hidden) op *= 0.55;
      n.opT = op;
      n.labT = 1;
      n.haloT =
        n.id === this.editTarget || n.id === this.dropTarget
          ? 1
          : n.id === this.connectFrom
            ? 0.9
            : n.id === sel
              ? 0.7
              : ends.includes(n.id)
                ? 0.4
                : 0;
    }
    for (const l of this.links.values()) {
      l.spark = false;
      if (l.kind === 'root') {
        l.opT = 0;
        continue;
      }
      const touches = !!sel && (end(l.source) === sel || end(l.target) === sel);
      const base = l.kind === 'cross' ? 0.8 : 0.45;
      l.opT = l.id === this.editLink || l.id === this.hoverLink ? 1 : touches ? 0.95 : focused ? base * 0.55 : base;
    }
    if (this.sparkSig !== '') {
      this.sparkSig = '';
      this.g.linkDirectionalParticles(0);
    }
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.paused) return;
    const time = now / 1000;

    if (this.flight) {
      const f = this.flight;
      const k = Math.min(1, (now - f.start) / f.dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(f.p0, f.p1, e);
      this.controls.target.lerpVectors(f.t0, f.t1, e);
      if (k >= 1) this.flight = null;
    }

    if (this.hoverDirty && !this.press && !this.handle) {
      this.hoverDirty = false;
      const id = this.pointer.inside ? this.pick(this.pointer.x, this.pointer.y) : null;
      const link = this.editing && !id && this.pointer.inside ? this.pickLink(this.pointer.x, this.pointer.y) : null;
      if (id !== this.hover || link !== this.hoverLink) {
        this.hover = id;
        this.hoverLink = link;
        this.el.style.cursor = id || link ? 'pointer' : this.connectFrom ? 'crosshair' : '';
        this.retarget();
      }
    }

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
        // A hidden label is skipped by the label renderer entirely.
        v.label.visible = shown >= 0.02;
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
    const idle =
      this.drift && !this.editing && now - Math.max(this.lastInput, this.lastPointer) > 9000 && !this.selected && !this.dragging;
    this.controls.autoRotateSpeed += ((idle ? 0.3 : 0) - this.controls.autoRotateSpeed) * 0.02;
    this.controls.autoRotate = this.controls.autoRotateSpeed > 0.004;

    if (this.editing) this.drawOverlay();
  };
}
