import { download, exportName, libraryMarkdown } from '../notes';
import { actions, useStore } from '../store';

/** Download your notes and summaries (Markdown) or a full backup (JSON). */
export function ExportSheet({ focus, onClose }: { focus: string | null; onClose: () => void }) {
  const { lib, tree } = useStore();
  const topic = tree.get(focus);

  const items = [
    {
      title: 'All notes & summaries',
      hint: 'One Markdown file, organised by topic',
      run: () => download(exportName(lib.title, 'md'), libraryMarkdown(lib, tree)),
    },
    ...(topic
      ? [
          {
            title: `Only “${topic.title}”`,
            hint: 'This topic and everything inside it, as Markdown',
            run: () => download(exportName(topic.title, 'md'), libraryMarkdown(lib, tree, topic.id)),
          },
        ]
      : []),
    {
      title: 'Full backup',
      hint: 'Everything as JSON. To restore, replace data/library.json with it',
      run: () => download(exportName(lib.title, 'json', 'backup'), JSON.stringify(lib, null, 2), 'application/json'),
    },
  ];

  return (
    <div className="scrim" onPointerDown={onClose}>
      <div
        className="sheet"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="sheet-head">
          <div className="sheet-title">Export</div>
          <button className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="choices">
          {items.map((it, i) => (
            <button
              key={it.title}
              className="choice"
              autoFocus={i === 0}
              onClick={() => {
                it.run();
                actions.toast('Downloaded.');
                onClose();
              }}
            >
              <span className="result-title">{it.title}</span>
              <span className="result-where">{it.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
