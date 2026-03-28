package hnapi

// Item represents a raw HN API item (story, comment, poll, job, etc).
type Item struct {
	ID          int64   `json:"id"`
	Type        string  `json:"type"`
	By          string  `json:"by"`
	Time        int64   `json:"time"`
	Text        string  `json:"text"`
	Title       string  `json:"title"`
	URL         string  `json:"url"`
	Score       int     `json:"score"`
	Kids        []int64 `json:"kids"`
	Parent      int64   `json:"parent"`
	Descendants int     `json:"descendants"`
	Dead        bool    `json:"dead"`
	Deleted     bool    `json:"deleted"`
}
