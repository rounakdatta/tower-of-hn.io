"use client";

interface AudioPlayerProps {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (time: number) => void;
}

export function AudioPlayer({
  isPlaying,
  currentTime,
  duration,
  onPlay,
  onPause,
  onSeek,
}: AudioPlayerProps) {
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <div className="flex items-center gap-4 rounded-lg border border-neutral-700 bg-neutral-900 p-4">
      <button
        onClick={isPlaying ? onPause : onPlay}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-600 text-white transition-colors hover:bg-orange-500"
      >
        {isPlaying ? "⏸" : "▶"}
      </button>

      <div className="flex-1">
        <div
          className="relative h-2 cursor-pointer rounded-full bg-neutral-700"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            onSeek(pct * duration);
          }}
        >
          <div
            className="absolute left-0 top-0 h-full rounded-full bg-orange-600"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-xs text-neutral-500">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
}
