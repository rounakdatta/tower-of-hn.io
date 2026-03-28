"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Thread, Comment as HNComment } from "@/lib/types";
import {
  getAudioStreamURL,
  getThreadConversation,
  ThreadConversation,
} from "@/lib/api";

interface TableProps {
  thread: Thread;
}

// Color palette for different speakers
const SPEAKER_COLORS = [
  "text-orange-400",
  "text-blue-400",
  "text-green-400",
  "text-purple-400",
  "text-pink-400",
  "text-cyan-400",
  "text-yellow-400",
  "text-red-400",
];

function getSpeakerColor(username: string, speakerMap: Map<string, number>) {
  if (!speakerMap.has(username)) {
    speakerMap.set(username, speakerMap.size);
  }
  return SPEAKER_COLORS[speakerMap.get(username)! % SPEAKER_COLORS.length];
}

export function Table({ thread }: TableProps) {
  const [expanded, setExpanded] = useState(false);
  const [conversation, setConversation] = useState<ThreadConversation | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [activeCommentId, setActiveCommentId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speakerMapRef = useRef(new Map<string, number>());

  const isReady = thread.status === "ready";

  const statusConfig = {
    pending: { color: "bg-neutral-600", label: "Generating..." },
    processing: {
      color: "bg-yellow-600 animate-pulse",
      label: "Processing...",
    },
    ready: { color: "bg-green-500", label: "Listen" },
    error: { color: "bg-red-600", label: "Error" },
  }[thread.status];

  // Load full conversation when expanded
  useEffect(() => {
    if (!expanded || conversation) return;
    setLoading(true);
    getThreadConversation(thread.id)
      .then(setConversation)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [expanded, thread.id, conversation]);

  // Track which comment is being spoken based on audio time
  const updateActiveComment = useCallback(() => {
    if (!conversation?.comments || !audioRef.current) return;
    const ms = audioRef.current.currentTime * 1000;
    const active = conversation.comments.find(
      (c) =>
        c.audio_segment &&
        ms >= c.audio_segment.start_ms &&
        ms < c.audio_segment.start_ms + c.audio_segment.duration_ms
    );
    setActiveCommentId(active?.id ?? null);
  }, [conversation]);

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
        updateActiveComment();
      });
      audio.addEventListener("ended", () => {
        setIsPlaying(false);
        setActiveCommentId(null);
      });
      audio.addEventListener("loadedmetadata", () =>
        setDuration(audio.duration || 0)
      );
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
  const comments = conversation?.comments || [];

  // Build a tree structure for rendering
  const commentById = new Map(comments.map((c) => [c.id, c]));
  const childrenOf = new Map<number | null, HNComment[]>();
  for (const c of comments) {
    const parentKey = c.parent_id ?? null;
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
    childrenOf.get(parentKey)!.push(c);
  }

  // Find root comment
  const rootComment = commentById.get(thread.root_comment_id);

  function renderComment(comment: HNComment, depth: number) {
    const isSpeaking = activeCommentId === comment.id;
    const color = getSpeakerColor(comment.by, speakerMapRef.current);
    const children = childrenOf.get(comment.id) || [];

    return (
      <div key={comment.id} className={depth > 0 ? "ml-4 border-l border-neutral-800 pl-3" : ""}>
        <div
          className={`py-2 transition-all ${
            isSpeaking
              ? "rounded bg-neutral-800/80 px-2 ring-1 ring-green-500/40"
              : ""
          }`}
        >
          <div className="flex items-center gap-2">
            {isSpeaking && (
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
            )}
            <span className={`text-xs font-semibold ${color}`}>
              {comment.by}
            </span>
            {comment.voice_id && (
              <span className="text-[10px] text-neutral-600">
                {comment.voice_id}
              </span>
            )}
          </div>
          <p
            className={`mt-1 text-sm leading-relaxed ${
              isSpeaking ? "text-neutral-100" : "text-neutral-400"
            }`}
          >
            {comment.text_plain.length > 300
              ? comment.text_plain.slice(0, 300) + "..."
              : comment.text_plain}
          </p>
        </div>
        {children.map((child) => renderComment(child, depth + 1))}
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg border bg-neutral-900 transition-all ${
        isReady
          ? "cursor-pointer border-neutral-700 hover:border-green-600/40"
          : "border-neutral-800"
      } ${expanded ? "border-green-600/40" : ""}`}
    >
      {/* Header — always visible */}
      <div className="p-4" onClick={handleClick}>
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
              <span>{thread.comment_count} in conversation</span>
            </div>
          </div>
          <div className="ml-4 flex shrink-0 items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full ${statusConfig.color}`}
            />
            <span
              className={`text-xs ${
                isReady ? "font-medium text-green-400" : "text-neutral-500"
              }`}
            >
              {statusConfig.label}
            </span>
          </div>
        </div>
      </div>

      {/* Expanded: audio player + conversation tree */}
      {expanded && isReady && (
        <div className="border-t border-neutral-800">
          {/* Audio player bar */}
          <div
            className="flex items-center gap-3 bg-neutral-950/50 px-4 py-3"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={togglePlay}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-600 text-white transition-colors hover:bg-green-500"
            >
              {isPlaying ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <rect x="3" y="2" width="4" height="12" rx="1" />
                  <rect x="9" y="2" width="4" height="12" rx="1" />
                </svg>
              ) : (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M4 2.5v11l9-5.5z" />
                </svg>
              )}
            </button>
            <div className="flex-1">
              <div
                className="relative h-1.5 cursor-pointer rounded-full bg-neutral-700"
                onClick={handleSeek}
              >
                <div
                  className="absolute left-0 top-0 h-full rounded-full bg-green-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-neutral-500">
              {formatTime(currentTime)} / {duration > 0 ? formatTime(duration) : "--:--"}
            </span>
          </div>

          {/* Conversation thread */}
          <div className="max-h-[500px] overflow-y-auto px-4 pb-4 pt-2">
            {loading && (
              <p className="py-4 text-center text-sm text-neutral-500">
                Loading conversation...
              </p>
            )}
            {!loading && rootComment && renderComment(rootComment, 0)}
            {!loading && !rootComment && comments.length === 0 && (
              <p className="py-4 text-center text-sm text-neutral-500">
                No comments loaded yet.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
