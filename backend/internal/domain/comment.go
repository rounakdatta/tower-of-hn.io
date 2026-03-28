package domain

import "time"

type Comment struct {
	ID        int64     `json:"id"`
	StoryID   int64     `json:"story_id"`
	ParentID  *int64    `json:"parent_id,omitempty"`
	By        string    `json:"by"`
	TextHTML  string    `json:"text_html"`
	TextPlain string    `json:"text_plain"`
	HNTime    time.Time `json:"time"`
	Dead      bool      `json:"dead,omitempty"`
	Deleted   bool      `json:"deleted,omitempty"`
	ChildIDs  []int64   `json:"child_ids,omitempty"`
	Depth     int       `json:"depth"`
	FetchedAt time.Time `json:"fetched_at"`

	// Enriched fields for API responses
	Sentiment *Sentiment   `json:"sentiment,omitempty"`
	Avatar    *AvatarState `json:"avatar,omitempty"`
	VoiceID   string       `json:"voice_id,omitempty"`
	Audio     *AudioTiming `json:"audio_segment,omitempty"`
}

// AudioTiming represents where this comment's audio sits within the thread audio.
type AudioTiming struct {
	SequenceOrder int `json:"sequence_order"`
	StartMs       int `json:"start_ms"`
	DurationMs    int `json:"duration_ms"`
}

// Ensure Audio field uses the AudioTiming type properly
func (c *Comment) SetAudioTiming(seq, startMs, durationMs int) {
	c.Audio = &AudioTiming{
		SequenceOrder: seq,
		StartMs:       startMs,
		DurationMs:    durationMs,
	}
}
