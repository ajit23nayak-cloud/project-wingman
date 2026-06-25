"use client";

import { useEffect, useState } from "react";

export type Density = "compact" | "comfortable" | "spacious";

const STORAGE_KEY = "wingman_density";
const EVENT_NAME = "wingman:density-change";
const DEFAULT: Density = "comfortable";
const ORDER: Density[] = ["comfortable", "compact", "spacious"];

function readStorage(): Density {
  if (typeof window === "undefined") return DEFAULT;
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v === "compact" || v === "comfortable" || v === "spacious") return v;
  return DEFAULT;
}

export function useDensity(): Density {
  const [density, setDensity] = useState<Density>(DEFAULT);
  useEffect(() => {
    setDensity(readStorage());
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<Density>).detail;
      if (next) setDensity(next);
    };
    window.addEventListener(EVENT_NAME, onChange as EventListener);
    return () =>
      window.removeEventListener(EVENT_NAME, onChange as EventListener);
  }, []);
  return density;
}

function nextDensity(current: Density): Density {
  const i = ORDER.indexOf(current);
  return ORDER[(i + 1) % ORDER.length];
}

function DensityGlyph({ density }: { density: Density }) {
  const gap = density === "compact" ? 3 : density === "comfortable" ? 5 : 7;
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="3" y1={8 - gap} x2="13" y2={8 - gap} />
      <line x1="3" y1="8" x2="13" y2="8" />
      <line x1="3" y1={8 + gap} x2="13" y2={8 + gap} />
    </svg>
  );
}

export function DensityToggle() {
  const density = useDensity();
  const handleClick = () => {
    const next = nextDensity(density);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next);
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }));
    }
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`Density: ${density}. Click to change.`}
      title={`Density: ${density}`}
      className="rounded-md border border-gray-300 px-2 py-1.5 hover:bg-gray-50 text-gray-600"
    >
      <DensityGlyph density={density} />
    </button>
  );
}
