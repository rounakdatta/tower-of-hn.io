package handler

import (
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store"
)

type AudioHandler struct {
	audio store.AudioStore
	blobs store.BlobStore
}

func NewAudioHandler(audio store.AudioStore, blobs store.BlobStore) *AudioHandler {
	return &AudioHandler{audio: audio, blobs: blobs}
}

func (h *AudioHandler) Stream(w http.ResponseWriter, r *http.Request) {
	threadIDStr := chi.URLParam(r, "threadId")
	threadID, err := strconv.ParseInt(threadIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid thread ID", http.StatusBadRequest)
		return
	}

	threadAudio, err := h.audio.GetThreadAudio(r.Context(), threadID)
	if err != nil {
		http.Error(w, "Audio not found", http.StatusNotFound)
		return
	}

	reader, err := h.blobs.Read(r.Context(), threadAudio.FilePath)
	if err != nil {
		http.Error(w, "Failed to read audio file", http.StatusInternalServerError)
		return
	}
	defer reader.Close()

	// Check if the reader supports seeking (local files do, S3 streams may not)
	rs, ok := reader.(io.ReadSeeker)
	if ok {
		http.ServeContent(w, r, "conversation.mp3", threadAudio.CreatedAt, rs)
	} else {
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Content-Length", strconv.FormatInt(threadAudio.FileSizeBytes, 10))
		io.Copy(w, reader)
	}
}
