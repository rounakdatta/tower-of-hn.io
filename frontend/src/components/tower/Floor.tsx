"use client";

import Link from "next/link";
import { Story } from "@/lib/types";

interface FloorProps {
  story: Story;
  index: number;
}

export function Floor({ story, index }: FloorProps) {
  const rank = story.rank ?? index + 1;

  return (
    <Link href={`/floor/${story.id}`}>
      <div
        className="group relative mb-1 cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:z-10"
        style={{
          transform: `rotateX(2deg)`,
        }}
      >
        {/* Isometric floor tile */}
        <div className="relative flex items-center gap-4 rounded-sm border border-neutral-700 bg-neutral-900 px-6 py-4 shadow-lg transition-colors group-hover:border-orange-500 group-hover:bg-neutral-800">
          {/* Rank badge */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-orange-600 text-sm font-bold text-white">
            {rank}
          </div>

          {/* Story info */}
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-medium text-neutral-100 group-hover:text-orange-400">
              {story.title}
            </h3>
            <div className="mt-1 flex gap-3 text-xs text-neutral-500">
              <span>{story.score} pts</span>
              <span>{story.by}</span>
              <span>{story.descendants} comments</span>
            </div>
          </div>

          {/* Activity indicator */}
          <div className="flex flex-col items-center text-xs text-neutral-600">
            <span className="text-lg">
              {story.threads_ready !== undefined && story.thread_count
                ? `${story.threads_ready}/${story.thread_count}`
                : ""}
            </span>
          </div>
        </div>

        {/* Left face (depth effect) */}
        <div className="absolute -bottom-1 left-0 right-0 h-1 skew-x-[-45deg] bg-neutral-950" />
      </div>
    </Link>
  );
}
