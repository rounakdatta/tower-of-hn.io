"use client";

import { useState, useEffect } from "react";
import { Story } from "@/lib/types";
import { getStories } from "@/lib/api";

export function useStories(limit = 30) {
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetch() {
      try {
        const data = await getStories(limit);
        if (!cancelled) {
          setStories(data.stories || []);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      }
    }

    fetch();
    return () => {
      cancelled = true;
    };
  }, [limit]);

  return { stories, loading, error };
}
