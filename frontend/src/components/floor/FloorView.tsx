"use client";

import { Thread } from "@/lib/types";
import { Table } from "./Table";

interface FloorViewProps {
  storyTitle: string;
  threads: Thread[];
}

export function FloorView({ storyTitle, threads }: FloorViewProps) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-xl font-bold text-neutral-100">
        {storyTitle}
      </h1>
      <div className="space-y-4">
        {threads.map((thread) => (
          <Table key={thread.id} thread={thread} />
        ))}
        {threads.length === 0 && (
          <p className="text-neutral-500">No discussions yet.</p>
        )}
      </div>
    </div>
  );
}
