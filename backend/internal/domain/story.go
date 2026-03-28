package domain

import "time"

type Story struct {
	ID          int64     `json:"id"`
	Title       string    `json:"title"`
	URL         string    `json:"url,omitempty"`
	Score       int       `json:"score"`
	By          string    `json:"by"`
	HNTime      time.Time `json:"hn_time"`
	Descendants int       `json:"descendants"`
	Rank        *int      `json:"rank,omitempty"`
	FetchedAt   time.Time `json:"fetched_at"`
	UpdatedAt   time.Time `json:"updated_at"`

	// Enriched fields for API responses
	ThreadCount  int `json:"thread_count,omitempty"`
	ThreadsReady int `json:"threads_ready,omitempty"`
}
