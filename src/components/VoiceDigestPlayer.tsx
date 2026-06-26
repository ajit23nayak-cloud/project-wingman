// Decorative "Voice Digest" widget rendered inside the homepage dashboard
// preview (Commit 17). Lavender Cred gradient + dark round play button +
// 20-bar audio waveform + tabular duration. v0 is visual-only; v1 could
// wire to actual TTS playback (deferred to Commit 19, was-Mega-C).

const WAVE_BAR_HEIGHTS = [
  8, 14, 18, 12, 20, 24, 18, 10, 16, 22, 14, 8, 12, 20, 16, 10, 6, 4, 6, 8,
];

const HIGHLIGHTED_BARS = new Set([5, 9]); // index → opacity 0.9 / 0.7

export function VoiceDigestPlayer() {
  return (
    <div
      className="mb-5 flex items-center gap-4 rounded-[12px] px-5 py-4"
      style={{ background: "var(--cred-grad-lavender)" }}
    >
      <div
        aria-hidden="true"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm"
        style={{
          background: "var(--cred-text-primary)",
          color: "var(--cred-page-bg)",
          paddingLeft: 3,
        }}
      >
        ▶
      </div>
      <div className="flex-1">
        <div
          className="text-[10.5px] font-medium uppercase tracking-[0.08em]"
          style={{ color: "#5a3d8c" }}
        >
          ✦ your morning briefing
        </div>
        <div className="cred-ui-lower text-[14px] text-[var(--cred-text-primary)]">
          5 minutes. everything you missed overnight.
        </div>
      </div>
      <div
        className="flex h-6 items-center gap-[2px]"
        aria-hidden="true"
      >
        {WAVE_BAR_HEIGHTS.map((h, i) => (
          <span
            key={i}
            className="rounded-[1px]"
            style={{
              width: 2,
              height: h,
              background: "#6b4ba8",
              opacity: HIGHLIGHTED_BARS.has(i) ? (i === 5 ? 0.9 : 0.7) : 0.5,
            }}
          />
        ))}
      </div>
      <div
        className="text-[13px] font-medium tabular-nums"
        style={{ color: "#5a3d8c" }}
      >
        5:12
      </div>
    </div>
  );
}
