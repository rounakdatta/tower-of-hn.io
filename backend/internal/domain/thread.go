package domain

import "time"

type ThreadStatus string

const (
	ThreadStatusPending    ThreadStatus = "pending"
	ThreadStatusProcessing ThreadStatus = "processing"
	ThreadStatusReady      ThreadStatus = "ready"
	ThreadStatusError      ThreadStatus = "error"
)

type Thread struct {
	ID            int64        `json:"id"`
	StoryID       int64        `json:"story_id"`
	RootCommentID int64        `json:"root_comment_id"`
	CommentCount  int          `json:"comment_count"`
	Status        ThreadStatus `json:"status"`
	UpdatedAt     time.Time    `json:"updated_at"`

	// Enriched fields for API responses
	RootComment    *Comment `json:"root_comment,omitempty"`
	Participants   []string `json:"participants,omitempty"`
	AudioDurationMs int     `json:"audio_duration_ms,omitempty"`
}
