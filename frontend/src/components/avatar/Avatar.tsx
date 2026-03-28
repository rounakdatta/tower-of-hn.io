"use client";

interface AvatarProps {
  avatarUrl: string;
  username: string;
  isSpeaking?: boolean;
}

export function Avatar({ avatarUrl, username, isSpeaking }: AvatarProps) {
  return (
    <div
      className={`relative inline-block transition-all ${
        isSpeaking ? "scale-110 ring-2 ring-orange-500" : ""
      }`}
      title={username}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={avatarUrl}
        alt={`${username}'s avatar`}
        className="h-16 w-16 rounded-lg bg-neutral-800"
        loading="lazy"
      />
      <span className="mt-1 block text-center text-[10px] text-neutral-400">
        {username}
      </span>
    </div>
  );
}
