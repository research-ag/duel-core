// Inline SVG icons (no icon-font, no dependency): each one is a small
// 24-unit stroke path in currentColor, sized by the CSS of whatever wraps it.

import type { SVGProps } from "react";

const base: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export const ArrowRight = () => (
  <svg {...base}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const ArrowDown = () => (
  <svg {...base}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
);

export const Search = () => (
  <svg {...base}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const Pencil = () => (
  <svg {...base}>
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

export const Trash = () => (
  <svg {...base}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
  </svg>
);

export const Close = () => (
  <svg {...base}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const Copy = () => (
  <svg {...base}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a1 1 0 0 1 1-1h10" />
  </svg>
);

export const Check = () => (
  <svg {...base}>
    <path d="m5 12 5 5L20 7" />
  </svg>
);

export const Key = () => (
  <svg {...base}>
    <circle cx="8" cy="14" r="4" />
    <path d="m11 11 9-9M15 7l3 3M18 4l2 2" />
  </svg>
);

export const Image = () => (
  <svg {...base}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m21 16-5-5-8 8" />
  </svg>
);

export const Hammer = () => (
  <svg {...base}>
    <path d="m14 4 6 6-3 3-6-6Z" />
    <path d="m11 7-8 8 3 3 8-8" />
  </svg>
);

export const Bot = () => (
  <svg {...base}>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 8V4M8 4h8" />
    <circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

export const Plus = () => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/// The brand mark: two crossed blades, one gold, one ink — a duel.
export const BrandMark = () => (
  <svg viewBox="0 0 32 32" className="brand-mark" aria-hidden="true">
    <circle
      cx="16"
      cy="16"
      r="15"
      fill="none"
      stroke="rgba(255,255,255,0.14)"
    />
    <path
      d="M9 23 23 9M20 9h3v3"
      fill="none"
      stroke="#f6d886"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9 9l14 14M9 12V9h3"
      fill="none"
      stroke="#f3efe6"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
