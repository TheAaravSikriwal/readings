import { useState, type MutableRefObject } from 'react';
import type { MapCallbacks, MapView } from '../map/MapView';
import { actions, getState } from '../store';

/** What the edit screen has selected: a bubble, or a line. Parent lines are
 * `p:<child id>`; connections use their own id. */
export type EditSel = { node: string } | { link: string } | null;

export interface QuickSpec {
  x: number;
  y: number;
  label: string;
  kinds: ('topic' | 'article')[];
  onSubmit: (title: string, kind: 'topic' | 'article') => void;
}

export const isParentLine = (id: string) => id.startsWith('p:');

const name = (id: string | null | undefined) => (id && getState().tree.get(id)?.title) || 'it';

/** The edit screen's state, and what clicks and drags on the map do while it's open. */
export function useEditor(api: MutableRefObject<MapView | null>, onAddReading: (topic: string | null) => void) {
  const [sel, setSel] = useState<EditSel>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [quick, setQuick] = useState<QuickSpec | null>(null);
  const [titleTick, setTitleTick] = useState(0);
  const tree = () => getState().tree;

  const selNode = sel && 'node' in sel ? sel.node : null;
  const selLink = sel && 'link' in sel ? sel.link : null;

  /** The topic new things go in: the selected topic, or the selected reading's topic. */
  const here = (): string | null => {
    if (selNode) return tree().get(selNode)?.type === 'topic' ? selNode : tree().parentOf(selNode);
    if (selLink && isParentLine(selLink)) return tree().parentOf(selLink.slice(2));
    return null;
  };

  const dockSpot = () => ({ x: window.innerWidth / 2, y: window.innerHeight - 230 });

  const newTopic = (parent: string | null, at = dockSpot(), spawn?: { x: number; y: number; z: number } | null) =>
    setQuick({
      ...at,
      label: parent ? `New topic in “${name(parent)}”` : 'New topic, at the top level',
      kinds: ['topic'],
      onSubmit: (title) => {
        const id = actions.addTopic(parent, title);
        api.current?.spawnAt(id, spawn);
        setSel({ node: id });
      },
    });

  const connect = (a: string, b: string) => {
    setConnectFrom(null);
    if (a === b) return;
    const had = actions.linkBetween(a, b);
    if (!had) actions.connect(a, b);
    const l = actions.linkBetween(a, b);
    if (l) setSel({ link: l.id });
    actions.toast(had ? 'Those two were already connected.' : `Connected “${name(a)}” and “${name(b)}”. Say why on the right.`);
  };

  /** The + on a line: a new bubble in the middle of it. */
  const insertOn = (linkId: string, x: number, y: number) => {
    const mid = api.current?.midpointOf(linkId);
    if (isParentLine(linkId)) {
      const child = linkId.slice(2);
      const parent = tree().parentOf(child);
      setQuick({
        x,
        y,
        label: `A topic between “${name(parent)}” and “${name(child)}”`,
        kinds: ['topic'],
        onSubmit: (title) => {
          const id = actions.insertAbove(child, title);
          if (!id) return;
          api.current?.spawnAt(id, mid);
          setSel({ node: id });
        },
      });
      return;
    }
    const l = getState().lib.links.find((x) => x.id === linkId);
    if (!l) return;
    setQuick({
      x,
      y,
      label: `Between “${name(l.a)}” and “${name(l.b)}”`,
      kinds: ['topic', 'article'],
      onSubmit: (title, kind) => {
        const id = actions.insertOnLink(linkId, kind, title);
        if (!id) return;
        api.current?.spawnAt(id, mid);
        setSel({ node: id });
      },
    });
  };

  const moveEnd = (linkId: string, which: 'a' | 'b', target: string | null) => {
    if (!target) return;
    if (isParentLine(linkId)) {
      const child = linkId.slice(2);
      if (tree().get(target)?.type !== 'topic') return actions.toast('Only a topic can hold other bubbles.');
      if (actions.move(child, target)) actions.toast(`Moved “${name(child)}” into “${name(target)}”`);
      else actions.toast(`“${name(child)}” can’t go inside “${name(target)}”.`);
      return;
    }
    const why = actions.relink(linkId, which, target);
    if (why) return actions.toast(why);
    const l = getState().lib.links.find((x) => x.id === linkId);
    if (l) actions.toast(`Now connects “${name(l.a)}” and “${name(l.b)}”`);
  };

  const handlers: MapCallbacks = {
    onClick(id, ev) {
      if (connectFrom) return connect(connectFrom, id);
      if (ev.shiftKey && selNode && selNode !== id) return connect(selNode, id);
      setSel({ node: id });
    },
    onDblClick(id) {
      setSel({ node: id });
      setTitleTick((n) => n + 1);
    },
    onRightClick(id) {
      setSel({ node: id });
    },
    onBackground() {
      if (connectFrom) setConnectFrom(null);
      else setSel(null);
    },
    onBackgroundDbl(x, y) {
      newTopic(null, { x, y }, api.current?.worldAt(x, y));
    },
    onDrop(id, into) {
      if (actions.move(id, into)) actions.toast(`Moved “${name(id)}” into “${into ? name(into) : getState().lib.title}”`);
    },
    onPin(id, at) {
      actions.pin(id, at);
      actions.toast(`“${name(id)}” stays where you put it. “Let it float” in its settings undoes that.`);
    },
    onLinkClick(id) {
      if (connectFrom) return setConnectFrom(null);
      setSel({ link: id });
    },
    onLinkInsert: insertOn,
    onLinkEnd: moveEnd,
    onConnect: connect,
  };

  const remove = () => {
    if (selNode) {
      const t = name(selNode);
      actions.remove(selNode);
      setSel(null);
      actions.toast(`Deleted “${t}”. Ctrl+Z brings it back.`);
    } else if (selLink) {
      if (isParentLine(selLink)) return actions.toast('That line is where a bubble lives. Move the bubble instead.');
      actions.disconnect(selLink);
      setSel(null);
      actions.toast('Connection removed. Ctrl+Z brings it back.');
    }
  };

  const startConnect = (from = selNode) => {
    if (!from) return actions.toast('Select the bubble to connect from first.');
    setConnectFrom(from);
  };

  return {
    sel,
    setSel,
    selNode,
    selLink,
    connectFrom,
    setConnectFrom,
    startConnect,
    quick,
    setQuick,
    titleTick,
    focusTitle: () => setTitleTick((n) => n + 1),
    handlers,
    newTopic: (parent: string | null = here()) => newTopic(parent),
    addReading: (topic: string | null = here()) => onAddReading(topic),
    insertOn,
    remove,
    fit: () => (selNode ? api.current?.frameNode(selNode) : api.current?.frameAll()),
  };
}

export type Editor = ReturnType<typeof useEditor>;
