import { useLayoutEffect, useRef } from 'react';
import { EDITABLE } from '../store';

interface Props {
  value: string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
  autoFocus?: boolean;
}

/** A borderless field that saves as you type. Plain text on the read-only site. */
export function Edit({ value, onChange, placeholder, multiline, className = '', autoFocus }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  if (!EDITABLE) return value ? <div className={`edit ro ${className}`}>{value}</div> : null;

  if (multiline) {
    return (
      <textarea
        ref={ref}
        rows={1}
        className={`edit ${className}`}
        value={value ?? ''}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
    );
  }
  return (
    <input
      className={`edit ${className}`}
      value={value ?? ''}
      placeholder={placeholder}
      autoFocus={autoFocus}
      size={Math.max(4, (value || placeholder || '').length)}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
      }}
    />
  );
}
