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

	// Determine content type from the stored format
	contentType := "audio/wav"
	fileName := "conversation.wav"
	if threadAudio.Format == "mp3" {
		contentType = "audio/mpeg"
		fileName = "conversation.mp3"
	}

	// Check if the reader supports seeking (local files do, S3 streams may not)
	rs, ok := reader.(io.ReadSeeker)
	if ok {
		w.Header().Set("Content-Type", contentType)
		http.ServeContent(w, r, fileName, threadAudio.CreatedAt, rs)
	} else {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", strconv.FormatInt(threadAudio.FileSizeBytes, 10))
		io.Copy(w, reader)
	}
}
