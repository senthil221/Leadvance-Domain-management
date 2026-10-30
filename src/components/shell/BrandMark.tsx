import { brand } from "@/lib/brand";

// The square beside the app name: the company's letter in its colour.
export function BrandMark({ size }: { size: number }) {
  return (
    <span className="brand-mark" aria-hidden="true" style={brand.color ? { background: brand.color, color: "#fff" } : undefined}>
      {brand.letter ? (
        <span className="brand-letter">{brand.letter}</span>
      ) : (
        <svg width={size} height={size} viewBox="0 0 12 12" fill="none"><path d="M2 6h8M6 2a6.5 6.5 0 0 1 0 8M6 2a6.5 6.5 0 0 0 0 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      )}
    </span>
  );
}
