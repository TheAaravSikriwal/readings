import { useEffect, useRef, type MutableRefObject } from 'react';
import { EDITABLE, useStore } from '../store';
import { MapView, type MapCallbacks } from './MapView';

interface Props extends MapCallbacks {
  focus: string | null;
  selected: string | null;
  marked: string | null;
  paused: boolean;
  /** px the scene shifts (left, up) while the card is open */
  shiftX: number;
  shiftY: number;
  editing?: boolean;
  editNode?: string | null;
  editLink?: string | null;
  connectFrom?: string | null;
  /** px the edit screen's panels cover on the left and right, so the map sits between them */
  editInsets?: { left: number; right: number };
  /** The map itself, for the edit screen to fly the camera and place bubbles. */
  api?: MutableRefObject<MapView | null>;
}

export function MapCanvas({
  focus,
  selected,
  marked,
  paused,
  shiftX,
  shiftY,
  editing = false,
  editNode = null,
  editLink = null,
  connectFrom = null,
  editInsets,
  api,
  ...callbacks
}: Props) {
  const { lib, rev, pending } = useStore();
  const el = useRef<HTMLDivElement>(null);
  const view = useRef<MapView | null>(null);
  const cb = useRef(callbacks);
  cb.current = callbacks;

  useEffect(() => {
    const v = new MapView(
      el.current!,
      {
        onClick: (id, ev) => cb.current.onClick(id, ev),
        onDblClick: (id) => cb.current.onDblClick(id),
        onRightClick: (id, ev) => cb.current.onRightClick(id, ev),
        onBackground: () => cb.current.onBackground(),
        onDrop: (id, into) => cb.current.onDrop(id, into),
        onLinkClick: (id, ev) => cb.current.onLinkClick?.(id, ev),
        onLinkInsert: (id, x, y) => cb.current.onLinkInsert?.(id, x, y),
        onLinkEnd: (id, which, target) => cb.current.onLinkEnd?.(id, which, target),
        onConnect: (a, b) => cb.current.onConnect?.(a, b),
        onPin: (id, at) => cb.current.onPin?.(id, at),
        onBackgroundDbl: (x, y) => cb.current.onBackgroundDbl?.(x, y),
      },
      EDITABLE,
    );
    view.current = v;
    if (api) api.current = v;
    return () => {
      if (api) api.current = null;
      v.destroy();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => view.current?.sync(lib, pending), [lib, rev, pending]);
  useEffect(() => view.current?.setView(focus, selected, shiftX, shiftY), [focus, selected, shiftX, shiftY, rev]);
  useEffect(() => view.current?.mark(marked), [marked]);
  useEffect(() => view.current?.setPaused(paused), [paused]);
  useEffect(
    () => view.current?.setEdit(editing, editNode, editLink, connectFrom, editInsets?.left ?? 0, editInsets?.right ?? 0),
    [editing, editNode, editLink, connectFrom, editInsets?.left, editInsets?.right], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return <div className="map" ref={el} onContextMenu={(e) => e.preventDefault()} />;
}
