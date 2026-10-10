import { useEffect, useRef } from 'react';
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
}

export function MapCanvas({ focus, selected, marked, paused, shiftX, shiftY, ...callbacks }: Props) {
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
      },
      EDITABLE,
    );
    view.current = v;
    return () => v.destroy();
  }, []);

  useEffect(() => view.current?.sync(lib, pending), [lib, rev, pending]);
  useEffect(() => view.current?.setView(focus, selected, shiftX, shiftY), [focus, selected, shiftX, shiftY, rev]);
  useEffect(() => view.current?.mark(marked), [marked]);
  useEffect(() => view.current?.setPaused(paused), [paused]);

  return <div className="map" ref={el} onContextMenu={(e) => e.preventDefault()} />;
}
