"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";

interface SearchableSelectProps {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  required?: boolean;
  /** Optional per-option trailing indicator (e.g. "has authentic geometry"). */
  optionBadge?: (option: string) => React.ReactNode;
  maxVisible?: number;
}

/**
 * Free-text input with a filterable dropdown — behaves like a combobox.
 * Typing filters the option list; Enter/click picks; Escape closes.
 * An empty query shows the full list.
 */
export const SearchableSelect: React.FC<SearchableSelectProps> = ({
  id,
  value,
  onChange,
  options,
  placeholder,
  required,
  optionBadge,
  maxVisible = 9,
}) => {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [value, options]);

  useEffect(() => {
    setHighlight(0);
  }, [filtered]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const pick = (opt: string) => {
    onChange(opt);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open && filtered[highlight]) {
        e.preventDefault();
        pick(filtered[highlight]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          role="listbox"
          style={{
            position: "absolute",
            zIndex: 60,
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            margin: 0,
            padding: "4px",
            listStyle: "none",
            maxHeight: `${maxVisible * 34 + 8}px`,
            overflowY: "auto",
            background: "rgba(15, 23, 42, 0.98)",
            border: "1px solid rgba(255, 255, 255, 0.14)",
            borderRadius: "8px",
            boxShadow: "0 12px 32px rgba(0, 0, 0, 0.5)",
          }}
        >
          {filtered.slice(0, 200).map((opt, i) => (
            <li
              key={opt}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(opt);
              }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                padding: "7px 10px",
                borderRadius: "6px",
                fontSize: "13px",
                color: "#E2E8F0",
                cursor: "pointer",
                background: i === highlight ? "rgba(56, 189, 248, 0.16)" : "transparent",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {opt}
              </span>
              {optionBadge?.(opt)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
