import { Story, Thread, ThreadDetail, Comment } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function getStories(
  limit = 30
): Promise<{ stories: Story[] }> {
  return fetchJSON(`/api/stories?limit=${limit}`);
}

export async function getStory(id: number): Promise<Story> {
  return fetchJSON(`/api/stories/${id}`);
}

export async function getThreadsForStory(
  storyId: number
): Promise<{ story_id: number; threads: Thread[] }> {
  return fetchJSON(`/api/stories/${storyId}/threads`);
}

export async function getThread(threadId: number): Promise<ThreadDetail> {
  return fetchJSON(`/api/threads/${threadId}`);
}

export interface ThreadConversation {
  thread: Thread;
  comments: Comment[];
  audio: {
    total_duration_ms: number;
    segment_count: number;
    stream_url: string;
  } | null;
}

export async function getThreadConversation(
  threadId: number
): Promise<ThreadConversation> {
  return fetchJSON(`/api/threads/${threadId}`);
}

export function getAudioStreamURL(threadId: number): string {
  return `${API_BASE}/api/audio/${threadId}/stream`;
}
