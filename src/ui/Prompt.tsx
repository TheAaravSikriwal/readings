import { useState } from 'react';

export interface PromptSpec {
  title: string;
  placeholder?: string;
  initial?: string;
  action?: string;
  onSubmit: (value: string) => void;
}

/** One-line input in a small floating sheet (new topic, rename, paste a link). */
export function Prompt({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
  const [value, setValue] = useState(spec.initial ?? '');
  const submit = () => {
    const v = value.trim();
    if (v) spec.onSubmit(v);
    onClose();
  };
  return (
    <div className="scrim" onPointerDown={onClose}>
      <div className="sheet" onPointerDown={(e) => e.stopPropagation()}>
        <div className="sheet-title">{spec.title}</div>
        <input
          autoFocus
          className="sheet-input"
          value={value}
          placeholder={spec.placeholder}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className="sheet-actions">
          <button className="ghost" onClick={onClose}>
            cancel
          </button>
          <button className="pill solid" onClick={submit}>
            {spec.action ?? 'ok'}
          </button>
        </div>
      </div>
    </div>
  );
}
