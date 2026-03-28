package domain

import "time"

type Sentiment struct {
	CommentID    int64     `json:"comment_id"`
	Label        string    `json:"label"`
	Confidence   float64   `json:"confidence"`
	Emotion      string    `json:"emotion"`
	ModelVersion string    `json:"model_version"`
	AnalyzedAt   time.Time `json:"analyzed_at"`
}

// SentimentLabel constants for classification output.
const (
	SentimentHappy        = "happy"
	SentimentExcited      = "excited"
	SentimentAngry        = "angry"
	SentimentSarcastic    = "sarcastic"
	SentimentConfused     = "confused"
	SentimentDisappointed = "disappointed"
	SentimentNeutral      = "neutral"
	SentimentSurprised    = "surprised"
	SentimentSad          = "sad"
	SentimentAmused       = "amused"
	SentimentThinking     = "thinking"
)
