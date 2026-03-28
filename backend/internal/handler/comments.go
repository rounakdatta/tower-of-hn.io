package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/avatar"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/tts"
)

type ThreadHandler struct {
	threads    store.ThreadStore
	comments   store.CommentStore
	audio      store.AudioStore
	voices     store.VoiceStore
	sentiments store.SentimentStore
}

func NewThreadHandler(threads store.ThreadStore, comments store.CommentStore, audio store.AudioStore, voices store.VoiceStore, sentiments store.SentimentStore) *ThreadHandler {
	return &ThreadHandler{threads: threads, comments: comments, audio: audio, voices: voices, sentiments: sentiments}
}

func (h *ThreadHandler) ListForStory(w http.ResponseWriter, r *http.Request) {
	storyIDStr := chi.URLParam(r, "id")
	storyID, err := strconv.ParseInt(storyIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid story ID", http.StatusBadRequest)
		return
	}

	threads, err := h.threads.GetThreadsForStory(r.Context(), storyID)
	if err != nil {
		http.Error(w, "Failed to fetch threads", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"story_id": storyID,
		"threads":  threads,
	})
}

func (h *ThreadHandler) Get(w http.ResponseWriter, r *http.Request) {
	threadIDStr := chi.URLParam(r, "threadId")
	threadID, err := strconv.ParseInt(threadIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid thread ID", http.StatusBadRequest)
		return
	}

	thread, err := h.threads.GetThread(r.Context(), threadID)
	if err != nil {
		http.Error(w, "Thread not found", http.StatusNotFound)
		return
	}

	// Load full comment tree for this thread
	comments, err := h.comments.GetThreadComments(r.Context(), thread.RootCommentID)
	if err != nil {
		http.Error(w, "Failed to load comments", http.StatusInternalServerError)
		return
	}

	// Enrich comments with voice assignments and avatar URLs
	for _, c := range comments {
		voiceID, err := h.voices.GetVoice(r.Context(), c.By)
		if err == nil && voiceID != "" {
			c.VoiceID = voiceID
		} else {
			c.VoiceID = tts.AssignVoice(c.By)
		}

		// Load cached sentiment from DB (populated by pipeline)
		sentimentLabel := "neutral"
		if cached, err := h.sentiments.GetSentiment(r.Context(), c.ID); err == nil && cached != nil {
			sentimentLabel = cached.Label
			c.Sentiment = cached
		}
		c.Avatar = &domain.AvatarState{
			CommentID: c.ID,
			Username:  c.By,
			Emotion:   avatar.SentimentToEmotion[sentimentLabel],
			Pose:      avatar.SentimentToPose[sentimentLabel],
			AvatarURL: avatar.BuildComicGenURL(c.By, sentimentLabel, false),
		}
	}

	// Load audio segments if thread is ready
	var audioMeta interface{}
	if thread.Status == "ready" {
		segments, _ := h.audio.GetSegments(r.Context(), threadID)
		threadAudio, _ := h.audio.GetThreadAudio(r.Context(), threadID)

		// Build segment timing map (comment_id -> timing)
		segmentMap := make(map[int64]map[string]int)
		runningMs := 0
		for _, seg := range segments {
			segmentMap[seg.CommentID] = map[string]int{
				"sequence_order": seg.SequenceOrder,
				"start_ms":       runningMs,
				"duration_ms":    seg.DurationMs,
			}
			runningMs += seg.DurationMs + 600 // approximate silence gap
		}

		// Attach timing to comments
		for _, c := range comments {
			if timing, ok := segmentMap[c.ID]; ok {
				c.SetAudioTiming(timing["sequence_order"], timing["start_ms"], timing["duration_ms"])
			}
		}

		if threadAudio != nil {
			audioMeta = map[string]interface{}{
				"total_duration_ms": threadAudio.TotalDurationMs,
				"segment_count":     threadAudio.SegmentCount,
				"stream_url":        "/api/audio/" + threadIDStr + "/stream",
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"thread":   thread,
		"comments": comments,
		"audio":    audioMeta,
	})
}
