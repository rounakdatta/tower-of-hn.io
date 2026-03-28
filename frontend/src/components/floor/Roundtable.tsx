"use client";

import { Comment as HNComment } from "@/lib/types";

interface Participant {
  username: string;
  isSpeaking: boolean;
  // Avatar URL changes based on what the person is currently saying
  avatarUrl: string;
  // Default (neutral) avatar when not speaking
  defaultAvatarUrl: string;
}

interface RoundtableProps {
  participants: Participant[];
  isPlaying: boolean;
}

export function Roundtable({ participants, isPlaying }: RoundtableProps) {
  const count = participants.length;
  // Scale table based on participant count
  const tableSize = Math.max(80, Math.min(140, 50 + count * 18));
  const seatDistance = tableSize / 2 + 75;
  const avatarSize = 90;
  const viewSize = (seatDistance + avatarSize / 2 + 20) * 2;
  const center = viewSize / 2;

  return (
    <div className="flex justify-center overflow-hidden py-2">
      <div
        className="relative"
        style={{ width: viewSize, height: viewSize, maxWidth: "100%" }}
      >
        {/* Table surface */}
        <div
          className="absolute rounded-full border-2 border-neutral-700 bg-neutral-900 shadow-lg"
          style={{
            width: tableSize,
            height: tableSize,
            left: center - tableSize / 2,
            top: center - tableSize / 2,
          }}
        >
          {/* Inner ring */}
          <div
            className="absolute inset-2 rounded-full border border-neutral-800"
          />
          {/* Center dot when playing */}
          {isPlaying && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="h-3 w-3 animate-pulse rounded-full bg-green-500" />
            </div>
          )}
        </div>

        {/* Seated characters */}
        {participants.map((p, i) => {
          const angle = (2 * Math.PI * i) / count - Math.PI / 2;
          const x = center + seatDistance * Math.cos(angle) - avatarSize / 2;
          const y = center + seatDistance * Math.sin(angle) - avatarSize / 2;

          // Pick the right avatar: sentiment-based when speaking, default otherwise
          const imgUrl = p.isSpeaking ? p.avatarUrl : p.defaultAvatarUrl;

          return (
            <div
              key={p.username}
              className="absolute transition-all duration-300"
              style={{
                left: x,
                top: y,
                width: avatarSize,
                height: avatarSize,
              }}
            >
              {/* Glow ring when speaking */}
              {p.isSpeaking && (
                <div
                  className="absolute -inset-2 animate-pulse rounded-full border-2 border-green-500/60 shadow-[0_0_15px_rgba(34,197,94,0.3)]"
                />
              )}

              {/* Character image */}
              <div
                className={`relative overflow-hidden rounded-full border-2 bg-neutral-800 transition-all ${
                  p.isSpeaking
                    ? "border-green-500 scale-110"
                    : "border-neutral-700"
                }`}
                style={{ width: avatarSize, height: avatarSize }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imgUrl}
                  alt={p.username}
                  className="h-full w-full object-cover object-top"
                  loading="eager"
                />
              </div>

              {/* Name tag */}
              <div
                className={`mt-1 text-center text-[10px] font-medium transition-colors ${
                  p.isSpeaking ? "text-green-400" : "text-neutral-500"
                }`}
              >
                {p.username.length > 12
                  ? p.username.slice(0, 11) + "…"
                  : p.username}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Helper to build participant data from comments
export function buildParticipants(
  comments: HNComment[],
  activeSpeaker: string | null,
  activeCommentId: number | null
): { username: string; isSpeaking: boolean; avatarUrl: string; defaultAvatarUrl: string }[] {
  // Collect unique speakers
  const seen = new Set<string>();
  const participants: { username: string; isSpeaking: boolean; avatarUrl: string; defaultAvatarUrl: string }[] = [];

  for (const c of comments) {
    if (!c.by || c.by === "[deleted]" || seen.has(c.by)) continue;
    seen.add(c.by);

    // Find the active comment's avatar (sentiment-driven expression)
    const activeComment = activeCommentId
      ? comments.find((cc) => cc.id === activeCommentId && cc.by === c.by)
      : null;

    // Default neutral avatar for this user
    const defaultUrl = c.avatar?.avatar_url || "";

    // If this user is currently speaking, use the active comment's avatar
    const speakingUrl = activeComment?.avatar?.avatar_url || defaultUrl;

    participants.push({
      username: c.by,
      isSpeaking: activeSpeaker === c.by,
      avatarUrl: speakingUrl,
      defaultAvatarUrl: defaultUrl,
    });
  }

  return participants;
}
