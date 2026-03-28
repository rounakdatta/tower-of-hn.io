"use client";

import { useStories } from "@/hooks/useStories";
import { Tower } from "@/components/tower/Tower";

export default function Home() {
  const { stories, loading, error } = useStories(10);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">
          <span className="text-orange-500">Tower</span> of HN
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Walk the floors. Hear the debates.
        </p>
      </header>

      <main className="mx-auto max-w-3xl">
        {loading && (
          <div className="flex items-center justify-center py-20">
            <p className="text-neutral-500">Loading stories...</p>
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center py-20">
            <p className="text-red-400">
              Failed to load stories. Is the backend running?
            </p>
          </div>
        )}
        {!loading && !error && <Tower stories={stories} />}
      </main>
    </div>
  );
}
