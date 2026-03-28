export interface Story {
  id: number;
  title: string;
  url?: string;
  score: number;
  by: string;
  hn_time: string;
  descendants: number;
  rank?: number;
  thread_count?: number;
  threads_ready?: number;
}

export interface Comment {
  id: number;
  story_id: number;
  parent_id?: number;
  by: string;
  text_html: string;
  text_plain: string;
  time: string;
  depth: number;
  sentiment?: Sentiment;
  avatar?: AvatarState;
  voice_id?: string;
  audio_segment?: AudioTiming;
}

export interface Sentiment {
  label: string;
  confidence: number;
  emotion: string;
}

export interface AvatarState {
  character: string;
  emotion: string;
  pose: string;
  avatar_url: string;
}

export interface AudioTiming {
  sequence_order: number;
  start_ms: number;
  duration_ms: number;
}

export interface Thread {
  id: number;
  story_id: number;
  root_comment_id: number;
  comment_count: number;
  status: "pending" | "processing" | "ready" | "error";
  root_comment?: Comment;
  participants?: string[];
  audio_duration_ms?: number;
}

export interface ThreadDetail {
  thread: Thread & {
    comments: Comment[];
    audio?: {
      total_duration_ms: number;
      segment_count: number;
      stream_url: string;
    };
  };
}

export interface WSMessage {
  type: string;
  data: Record<string, unknown>;
}
