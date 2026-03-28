package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store"
)

type ThreadHandler struct {
	threads  store.ThreadStore
	comments store.CommentStore
}

func NewThreadHandler(threads store.ThreadStore, comments store.CommentStore) *ThreadHandler {
	return &ThreadHandler{threads: threads, comments: comments}
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"thread": thread})
}
