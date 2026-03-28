"use client";

import { Thread } from "@/lib/types";

interface TableProps {
  thread: Thread;
}

export function Table({ thread }: TableProps) {
  const statusColor = {
    pending: "bg-neutral-600",
    processing: "bg-yellow-600",
    ready: "bg-green-600",
    error: "bg-red-600",
  }[thread.status];

  return (
    <div className="rounded-lg border border-neutral-700 bg-neutral-900 p-4 transition-colors hover:border-neutral-600">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          {thread.root_comment && (
            <p className="line-clamp-2 text-sm text-neutral-300">
              {thread.root_comment.text_plain}
            </p>
          )}
          <div className="mt-2 flex items-center gap-3 text-xs text-neutral-500">
            <span>{thread.root_comment?.by}</span>
            <span>{thread.comment_count} replies</span>
            {thread.audio_duration_ms && (
              <span>
                {Math.round(thread.audio_duration_ms / 1000)}s audio
              </span>
            )}
          </div>
        </div>
        <div className="ml-4 flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${statusColor}`}
          />
          <span className="text-xs text-neutral-500">{thread.status}</span>
        </div>
      </div>

      {thread.participants && thread.participants.length > 0 && (
        <div className="mt-3 flex -space-x-2">
          {thread.participants.slice(0, 5).map((username) => (
            <div
              key={username}
              className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-neutral-900 bg-neutral-700 text-[10px] font-medium text-neutral-300"
              title={username}
            >
              {username.slice(0, 2).toUpperCase()}
            </div>
          ))}
          {thread.participants.length > 5 && (
            <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-neutral-900 bg-neutral-800 text-[10px] text-neutral-400">
              +{thread.participants.length - 5}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
