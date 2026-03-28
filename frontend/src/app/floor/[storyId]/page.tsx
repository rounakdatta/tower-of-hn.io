"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Story, Thread } from "@/lib/types";
import { getStory, getThreadsForStory } from "@/lib/api";
import { FloorView } from "@/components/floor/FloorView";

export default function FloorPage() {
  const params = useParams();
  const storyId = Number(params.storyId);

  const [story, setStory] = useState<Story | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storyId) return;

    async function load() {
      try {
        const [storyData, threadsData] = await Promise.all([
          getStory(storyId),
          getThreadsForStory(storyId),
        ]);
        setStory(storyData);
        setThreads(threadsData.threads || []);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load discussion"
        );
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [storyId]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950">
        <p className="text-neutral-500">Loading floor...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4">
        <Link
          href="/"
          className="text-sm text-neutral-500 transition-colors hover:text-orange-400"
        >
          &larr; Back to Tower
        </Link>
      </header>
      {error ? (
        <div className="flex items-center justify-center py-20">
          <p className="text-red-400">{error}. Is the backend running?</p>
        </div>
      ) : (
        <FloorView
          storyTitle={story?.title || "Unknown story"}
          threads={threads}
        />
      )}
    </div>
  );
}
