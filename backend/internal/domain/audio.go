package domain

import "time"

type AudioSegment struct {
	ID             int64     `json:"id"`
	ThreadID       int64     `json:"thread_id"`
	CommentID      int64     `json:"comment_id"`
	VoiceID        string    `json:"voice_id"`
	FilePath       string    `json:"file_path"`
	StorageBackend string    `json:"storage_backend"`
	DurationMs     int       `json:"duration_ms"`
	SequenceOrder  int       `json:"sequence_order"`
	Format         string    `json:"format"`
	FileSizeBytes  int64     `json:"file_size_bytes"`
	CreatedAt      time.Time `json:"created_at"`
}

type ThreadAudio struct {
	ThreadID       int64     `json:"thread_id"`
	FilePath       string    `json:"file_path"`
	StorageBackend string    `json:"storage_backend"`
	TotalDurationMs int     `json:"total_duration_ms"`
	Format         string    `json:"format"`
	FileSizeBytes  int64     `json:"file_size_bytes"`
	SegmentCount   int       `json:"segment_count"`
	CreatedAt      time.Time `json:"created_at"`
}
