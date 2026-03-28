"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { AudioTiming } from "@/lib/types";

interface AudioState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  currentSegmentIndex: number;
}

export function useAudio(streamUrl: string | null, segments: AudioTiming[] = []) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<AudioState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    currentSegmentIndex: -1,
  });

  // Clean up audio element when URL changes or component unmounts
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    };
  }, [streamUrl]);

  const getOrCreateAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;
    if (!streamUrl) return null;

    const audio = new Audio(streamUrl);
    audioRef.current = audio;

    const onTimeUpdate = () => {
      const currentMs = audio.currentTime * 1000;
      const segIdx = segments.findIndex(
        (s) =>
          currentMs >= s.start_ms && currentMs < s.start_ms + s.duration_ms
      );
      setState({
        isPlaying: !audio.paused,
        currentTime: audio.currentTime,
        duration: audio.duration || 0,
        currentSegmentIndex: segIdx,
      });
    };

    const onEnded = () => {
      setState((prev) => ({ ...prev, isPlaying: false }));
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);

    return audio;
  }, [streamUrl, segments]);

  const play = useCallback(() => {
    const audio = getOrCreateAudio();
    audio?.play();
  }, [getOrCreateAudio]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setState((prev) => ({ ...prev, isPlaying: false }));
  }, []);

  const seek = useCallback((time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  }, []);

  const seekToSegment = useCallback(
    (index: number) => {
      if (segments[index] && audioRef.current) {
        audioRef.current.currentTime = segments[index].start_ms / 1000;
      }
    },
    [segments]
  );

  return { ...state, play, pause, seek, seekToSegment };
}
