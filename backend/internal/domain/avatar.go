package domain

import "time"

type AvatarState struct {
	CommentID int64     `json:"comment_id"`
	Username  string    `json:"username"`
	Character string    `json:"character"`
	Emotion   string    `json:"emotion"`
	Pose      string    `json:"pose"`
	AvatarURL string    `json:"avatar_url"`
	CreatedAt time.Time `json:"created_at"`
}
