"use client";

import { useState, useRef } from "react";
import { Thread } from "@/lib/types";
import { getAudioStreamURL } from "@/lib/api";

interface TableProps {
  thread: Thread;
}

export function Table({ thread }: TableProps) {
  const [expanded, setExpanded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const isReady = thread.status === "ready";

  const statusColor = {
    pending: "bg-neutral-600",
    processing: "bg-yellow-600 animate-pulse",
    ready: "bg-green-500",
    error: "bg-red-600",
  }[thread.status];

  const statusLabel = {
    pending: "Generating...",
    processing: "Processing audio...",
    ready: "Listen",
    error: "Error",
  }[thread.status];

  function handleClick() {
    if (!isReady) return;
    setExpanded(!expanded);
  }

  function togglePlay() {
    if (!audioRef.current) {
      const audio = new Audio(getAudioStreamURL(thread.id));
      audioRef.current = audio;

      audio.addEventListener("timeupdate", () => {
        setCurrentTime(audio.currentTime);
        setDuration(audio.duration || 0);
      });
      audio.addEventListener("ended", () => setIsPlaying(false));
      audio.addEventListener("loadedmetadata", () => {
        setDuration(audio.duration || 0);
      });
    }

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  }

  function handleSeek(e: React.MouseEvent<HTMLDivElement>) {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audioRef.current.currentTime = pct * duration;
  }

  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      className={`rounded-lg border bg-neutral-900 p-4 transition-all ${
        isReady
          ? "cursor-pointer border-neutral-700 hover:border-green-600/50"
          : "border-neutral-800"
      } ${expanded ? "border-green-600/50 ring-1 ring-green-600/20" : ""}`}
      onClick={handleClick}
    >
      {/* Thread info */}
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          {thread.root_comment && (
            <p className="line-clamp-2 text-sm text-neutral-300">
              {thread.root_comment.text_plain}
            </p>
          )}
          <div className="mt-2 flex items-center gap-3 text-xs text-neutral-500">
            <span className="font-medium text-neutral-400">
              {thread.root_comment?.by}
            </span>
            <span>{thread.comment_count} replies</span>
          </div>
        </div>
        <div className="ml-4 flex shrink-0 items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${statusColor}`} />
          <span
            className={`text-xs ${
              isReady ? "font-medium text-green-400" : "text-neutral-500"
            }`}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Audio player — shown when expanded */}
      {expanded && isReady && (
        <div
          className="mt-4 border-t border-neutral-800 pt-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3">
            {/* Play/Pause button */}
            <button
              onClick={togglePlay}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-600 text-white transition-colors hover:bg-green-500"
            >
              {isPlaying ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="3" y="2" width="4" height="12" rx="1" />
                  <rect x="9" y="2" width="4" height="12" rx="1" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4 2.5v11l9-5.5z" />
                </svg>
              )}
            </button>

            {/* Progress bar */}
            <div className="flex-1">
              <div
                className="relative h-2 cursor-pointer rounded-full bg-neutral-700"
                onClick={handleSeek}
              >
                <div
                  className="absolute left-0 top-0 h-full rounded-full bg-green-500 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mt-1 flex justify-between text-xs text-neutral-500">
                <span>{formatTime(currentTime)}</span>
                <span>{duration > 0 ? formatTime(duration) : "--:--"}</span>
              </div>
            </div>
          </div>

          <p className="mt-2 text-center text-xs text-neutral-600">
            {thread.comment_count} voices in conversation
          </p>
        </div>
      )}
    </div>
  );
}
