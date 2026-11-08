import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* Replacement for <select> / <input list>. Native popups are separate OS windows, and under the
   always-on-top Electron shell they open behind it, so clicking did "nothing". This menu is drawn
   in the page instead.

   options: [{ value, label }]
   editable: show a text box (value is free text; the list only suggests) — used for the model name
   onOpen: called each time the menu opens (the model list loads here)
   note: text shown in the menu when there are no options (e.g. "Loading…") */
export function Dropdown({ value, options, onChange, editable = false, onOpen, note, placeholder, id }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [box, setBox] = useState(null);
  const root = useRef(null);
  const menu = useRef(null);

  const current = options.find((o) => o.value === value);
  const close = () => { setOpen(false); setHi(-1); };
  const show = () => {
    if (open) return;
    setOpen(true);
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    onOpen?.();
  };
  const pick = (o) => { onChange(o.value); close(); };

  // place the menu under the field (above it when there is no room below)
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const r = root.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 160 && above > below;
    const max = Math.max(100, Math.min(260, up ? above : below));
    setBox({ left: r.left, width: r.width, maxHeight: max, ...(up ? { bottom: window.innerHeight - r.top + 2 } : { top: r.bottom + 2 }) });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!root.current?.contains(e.target) && !menu.current?.contains(e.target)) close(); };
    // Escape closes the menu only; it must not reach the island's own Escape handler
    const key = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(options.length - 1, h + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
      else if (e.key === "Enter" && hi >= 0 && options[hi]) { e.preventDefault(); pick(options[hi]); }
    };
    const scroll = (e) => { if (!menu.current?.contains(e.target)) close(); };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, hi, options]);

  useEffect(() => { menu.current?.querySelector(".hi")?.scrollIntoView({ block: "nearest" }); }, [hi]);

  return (
    <div className={`dd ${open ? "open" : ""}`} ref={root}>
      {editable ? (
        <input id={id} className="dd-input" value={value} placeholder={placeholder} spellCheck={false} autoComplete="off"
          onChange={(e) => onChange(e.target.value)} onFocus={show} onClick={show} />
      ) : (
        <button id={id} type="button" className="dd-btn" aria-haspopup="listbox" aria-expanded={open}
          onClick={() => (open ? close() : show())}>{current ? current.label : value}</button>
      )}
      <button type="button" className="dd-chev" tabIndex={-1} aria-label="Show options"
        onMouseDown={(e) => e.preventDefault()} onClick={() => (open ? close() : show())}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && box && createPortal(
        <div className="dd-menu" role="listbox" ref={menu} style={box}>
          {options.length === 0 && <div className="dd-note">{note || "Nothing to choose from"}</div>}
          {options.map((o, i) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value}
              className={`dd-opt ${o.value === value ? "on" : ""} ${i === hi ? "hi" : ""}`}
              onMouseEnter={() => setHi(i)} onClick={() => pick(o)}>{o.label}</button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
