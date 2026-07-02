"use client";

// Voice Digest player (Commit 19a wires real audio to what Commit 17
// shipped decoratively). Two modes:
//   - decorative={true}  (default for homepage's DashboardSnapshot):
//     static lavender Cred widget with 20-bar waveform + fixed "5:12".
//     No audio, no hook call.
//   - decorative={false} (mount on /dashboard): consumes useTodaysBriefing,
//     renders <audio> with the signed URL when status=ready, shows
//     fallback text otherwise.

import { useRef, useState } from "react";
import { useTodaysBriefing } from "@/lib/supabase/hooks";

const WAVE_BAR_HEIGHTS = [
  8, 14, 18, 12, 20, 24, 18, 10, 16, 22, 14, 8, 12, 20, 16, 10, 6, 4, 6, 8,
];
const HIGHLIGHTED_BARS = new Set([5, 9]);

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function StaticShell({
  eyebrow,
  title,
  duration,
  playButton,
}: {
  eyebrow: string;
  title: string;
  duration: string;
  playButton: React.ReactNode;
}) {
  return (
    <div
      className="mb-5 flex items-center gap-4 rounded-[12px] px-5 py-4"
      style={{ background: "var(--cred-grad-lavender)" }}
    >
      {playButton}
      <div className="flex-1">
        <div
          className="text-[10.5px] font-medium uppercase tracking-[0.08em]"
          style={{ color: "#5a3d8c" }}
        >
          {eyebrow}
        </div>
        <div className="cred-ui-lower text-[14px] text-[var(--cred-text-primary)]">
          {title}
        </div>
      </div>
      <div className="flex h-6 items-center gap-[2px]" aria-hidden="true">
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
        {duration}
      </div>
    </div>
  );
}

function DecorativePlayButton() {
  return (
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
  );
}

type VoiceDigestPlayerProps = {
  decorative?: boolean;
};

export function VoiceDigestPlayer({ decorative = false }: VoiceDigestPlayerProps) {
  if (decorative) {
    return (
      <StaticShell
        eyebrow="✦ your morning briefing"
        title="5 minutes. everything you missed overnight."
        duration="5:12"
        playButton={<DecorativePlayButton />}
      />
    );
  }
  return <LiveVoiceDigestPlayer />;
}

function LiveVoiceDigestPlayer() {
  const { data, isLoading } = useTodaysBriefing();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading || !data) {
    return (
      <StaticShell
        eyebrow="✦ your morning briefing"
        title="checking for today's briefing…"
        duration="--:--"
        playButton={<DecorativePlayButton />}
      />
    );
  }

  if (!data.ready) {
    const fallbackTitle =
      data.status === "generating"
        ? "brewing your first briefing… ☕"
        : data.status === "failed"
          ? "briefing generation failed. tomorrow we'll try again."
          : data.status === "pending"
            ? "your first briefing is being prepared — usually under 2 min"
            : "morning briefing arrives at 06:00 local time.";
    return (
      <StaticShell
        eyebrow="✦ your morning briefing"
        title={fallbackTitle}
        duration="--:--"
        playButton={<DecorativePlayButton />}
      />
    );
  }

  const handlePlay = async () => {
    setError(null);
    const el = audioRef.current;
    if (!el) return;
    try {
      if (playing) {
        el.pause();
      } else {
        await el.play();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "playback failed");
    }
  };

  return (
    <div
      className="mb-5 rounded-[12px] px-5 py-4"
      style={{ background: "var(--cred-grad-lavender)" }}
    >
      <div className="flex items-center gap-4">
        <button
          type="button"
          aria-label={playing ? "Pause briefing" : "Play briefing"}
          onClick={handlePlay}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm"
          style={{
            background: "var(--cred-text-primary)",
            color: "var(--cred-page-bg)",
            paddingLeft: playing ? 0 : 3,
          }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
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
        <div className="flex h-6 items-center gap-[2px]" aria-hidden="true">
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
          {formatDuration(data.durationSeconds)}
        </div>
      </div>
      <audio
        ref={audioRef}
        src={data.audioUrl}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setError("playback failed")}
      />
      {error && (
        <p className="cred-ui-lower mt-2 text-[11px]" style={{ color: "#b8425a" }}>
          {error}
        </p>
      )}
    </div>
  );
}
