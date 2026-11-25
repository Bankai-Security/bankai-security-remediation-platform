import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import './JiraOptionPicker.css';

export interface JiraPickerOption {
  value: string;
  label: string;
  detail?: string;
}

interface JiraOptionPickerProps {
  id: string;
  label: string;
  options: JiraPickerOption[];
  value: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export default function JiraOptionPicker({ id, label, options, value, placeholder, searchPlaceholder, emptyMessage, disabled = false, onChange }: JiraOptionPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) => `${option.label} ${option.detail ?? ''}`.toLowerCase().includes(normalized));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 0);
    const dismissOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismissEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissEscape);
    };
  }, [open]);

  const choose = (option: JiraPickerOption) => {
    onChange(option.value);
    setOpen(false);
    setQuery('');
    triggerRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' && open) {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp' && open) {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && open && filtered[activeIndex]) {
      event.preventDefault();
      choose(filtered[activeIndex]!);
    } else if (event.key === 'ArrowDown' && !open && !disabled) {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div className="jira-picker-field">
      <label htmlFor={id}>{label}</label>
      <div className="jira-option-picker" ref={rootRef} onKeyDown={handleKeyDown}>
        <button
          id={id}
          ref={triggerRef}
          type="button"
          className={`jira-option-picker-trigger${open ? ' jira-option-picker-trigger--open' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          <span className={selected ? '' : 'jira-option-picker-placeholder'}>{selected?.label || placeholder}</span>
          <svg className={`jira-option-picker-chevron${open ? ' jira-option-picker-chevron--open' : ''}`} width="12" height="8" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="m1 1.5 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {open && (
          <div className="jira-option-picker-menu">
            <div className="jira-option-picker-search-wrap">
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.8" cy="8.8" r="5.8" stroke="currentColor" strokeWidth="1.5"/><path d="m13.2 13.2 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              <input ref={searchRef} className="jira-option-picker-search" type="search" aria-label={searchPlaceholder} placeholder={searchPlaceholder} value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} />
            </div>
            <div id={`${id}-listbox`} className="jira-option-picker-options" role="listbox" aria-label={label}>
              {filtered.length ? filtered.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={`jira-option-picker-option${option.value === value ? ' jira-option-picker-option--selected' : ''}${index === activeIndex ? ' jira-option-picker-option--active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(option)}
                >
                  <span className="jira-option-picker-option-copy"><span className="jira-option-picker-option-name">{option.label}</span>{option.detail && <span className="jira-option-picker-option-detail">{option.detail}</span>}</span>
                  {option.value === value && <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8.5 3.2 3.1L13 4.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </button>
              )) : <div className="jira-option-picker-empty">{query ? `No matches for “${query}”.` : emptyMessage}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
