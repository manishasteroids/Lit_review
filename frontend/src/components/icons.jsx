import React from "react";

function Ic({ name, size = 16, color, className, style }) {
  const c = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: color || "currentColor", strokeWidth: 2, strokeLinecap: "round",
    strokeLinejoin: "round", className, style,
  };
  switch (name) {
    case "search": return <svg {...c}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
    case "file-text": return <svg {...c}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>;
    case "brain": return <svg {...c}><path d="M9.5 2a3 3 0 0 0-3 3 3 3 0 0 0-1.5 2.6A3 3 0 0 0 6 13.5V16a3 3 0 0 0 5.5 1.6V5A3 3 0 0 0 9.5 2z" /><path d="M14.5 2a3 3 0 0 1 3 3 3 3 0 0 1 1.5 2.6A3 3 0 0 1 18 13.5V16a3 3 0 0 1-5.5 1.6" /></svg>;
    case "pen-tool": return <svg {...c}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
    case "sparkles": return <svg {...c}><path d="M12 3l1.6 4.8L18 9l-4.4 1.2L12 15l-1.6-4.8L6 9l4.4-1.2z" /><path d="M19 14l.7 2.1L22 17l-2.3.6L19 20l-.7-2.4L16 17l2.3-.9z" /></svg>;
    case "network": return <svg {...c}><rect x="9" y="2" width="6" height="6" rx="1" /><rect x="2" y="16" width="6" height="6" rx="1" /><rect x="16" y="16" width="6" height="6" rx="1" /><path d="M12 8v4M5 16v-2h14v2" /></svg>;
    case "list-ordered": return <svg {...c}><line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" /><line x1="10" y1="18" x2="21" y2="18" /><path d="M4 6h1v4M4 10h2" /><path d="M6 18H4l2-2.5V14H4" /></svg>;
    case "help-circle": return <svg {...c}><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12" y2="17.01" /></svg>;
    case "play": return <svg {...c}><polygon points="6 4 20 12 6 20" /></svg>;
    case "check": return <svg {...c}><polyline points="20 6 9 17 4 12" /></svg>;
    case "x": return <svg {...c}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
    case "rotate-cw": return <svg {...c}><path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 4 21 9 16 9" /></svg>;
    case "chevron-right": return <svg {...c}><polyline points="9 6 15 12 9 18" /></svg>;
    case "layers": return <svg {...c}><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 12 12 17 22 12" /><polyline points="2 17 12 22 22 17" /></svg>;
    case "flask": return <svg {...c}><path d="M9 2v6.5L4 18a2 2 0 0 0 1.8 3h12.4A2 2 0 0 0 20 18l-5-9.5V2" /><line x1="8" y1="2" x2="16" y2="2" /><line x1="7" y1="14" x2="17" y2="14" /></svg>;
    case "book": return <svg {...c}><path d="M2 4h7a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H2z" /><path d="M22 4h-7a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H22z" /></svg>;
    case "bar-chart": return <svg {...c}><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" /><rect x="12" y="7" width="3" height="10" /><rect x="17" y="13" width="3" height="4" /></svg>;
    case "alert": return <svg {...c}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12" y2="17.01" /></svg>;
    case "cpu": return <svg {...c}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" /></svg>;
    case "filter": return <svg {...c}><polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5" /></svg>;
    case "plus": return <svg {...c}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
    case "trash2": return <svg {...c}><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>;
    default: return <svg {...c}><circle cx="12" cy="12" r="9" /></svg>;
  }
}

export const Search = (p) => <Ic name="search" {...p} />;
export const FileText = (p) => <Ic name="file-text" {...p} />;
export const Brain = (p) => <Ic name="brain" {...p} />;
export const PenTool = (p) => <Ic name="pen-tool" {...p} />;
export const Sparkles = (p) => <Ic name="sparkles" {...p} />;
export const Network = (p) => <Ic name="network" {...p} />;
export const ListOrdered = (p) => <Ic name="list-ordered" {...p} />;
export const HelpCircle = (p) => <Ic name="help-circle" {...p} />;
export const Play = (p) => <Ic name="play" {...p} />;
export const Check = (p) => <Ic name="check" {...p} />;
export const X = (p) => <Ic name="x" {...p} />;
export const RotateCw = (p) => <Ic name="rotate-cw" {...p} />;
export const ChevronRight = (p) => <Ic name="chevron-right" {...p} />;
export const Layers = (p) => <Ic name="layers" {...p} />;
export const FlaskConical = (p) => <Ic name="flask" {...p} />;
export const BookOpen = (p) => <Ic name="book" {...p} />;
export const BarChart3 = (p) => <Ic name="bar-chart" {...p} />;
export const AlertTriangle = (p) => <Ic name="alert" {...p} />;
export const Cpu = (p) => <Ic name="cpu" {...p} />;
export const Filter = (p) => <Ic name="filter" {...p} />;
export const Plus = (p) => <Ic name="plus" {...p} />;
export const Trash2 = (p) => <Ic name="trash2" {...p} />;
