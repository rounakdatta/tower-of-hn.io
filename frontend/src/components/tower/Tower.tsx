"use client";

import { Story } from "@/lib/types";
import { Floor } from "./Floor";

interface TowerProps {
  stories: Story[];
}

export function Tower({ stories }: TowerProps) {
  return (
    <div className="flex flex-col items-center py-8">
      <div className="relative" style={{ perspective: "1000px" }}>
        {stories.map((story, index) => (
          <Floor key={story.id} story={story} index={index} />
        ))}
      </div>
    </div>
  );
}
