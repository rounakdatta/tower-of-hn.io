package hnapi

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// StreamEvent represents a Firebase SSE event.
type StreamEvent struct {
	Event string          `json:"event"`
	Path  string          `json:"path"`
	Data  json.RawMessage `json:"data"`
}

// Streamer subscribes to HN Firebase SSE endpoints.
type Streamer struct {
	client  *http.Client
	baseURL string
	logger  *slog.Logger
}

func NewStreamer(baseURL string, logger *slog.Logger) *Streamer {
	return &Streamer{
		client: &http.Client{
			Timeout: 0, // no timeout for streaming
		},
		baseURL: baseURL,
		logger:  logger,
	}
}

// SubscribeTopStories opens an SSE connection to /topstories.json
// and sends events on the returned channel. Reconnects automatically on failure.
func (s *Streamer) SubscribeTopStories(ctx context.Context) (<-chan StreamEvent, error) {
	ch := make(chan StreamEvent, 64)

	go func() {
		defer close(ch)
		backoff := time.Second

		for {
			select {
			case <-ctx.Done():
				return
			default:
			}

			err := s.stream(ctx, "/topstories.json", ch)
			if err != nil && ctx.Err() == nil {
				s.logger.Warn("SSE stream disconnected, reconnecting", "error", err, "backoff", backoff)
				time.Sleep(backoff)
				backoff = min(backoff*2, 30*time.Second)
			}
		}
	}()

	return ch, nil
}

func (s *Streamer) stream(ctx context.Context, path string, ch chan<- StreamEvent) error {
	url := fmt.Sprintf("%s%s", s.baseURL, path)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	var eventType, data string

	for scanner.Scan() {
		line := scanner.Text()

		switch {
		case strings.HasPrefix(line, "event:"):
			eventType = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			data = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		case line == "":
			if eventType != "" && data != "" && eventType != "keep-alive" {
				var evt StreamEvent
				evt.Event = eventType

				var parsed struct {
					Path string          `json:"path"`
					Data json.RawMessage `json:"data"`
				}
				if err := json.Unmarshal([]byte(data), &parsed); err == nil {
					evt.Path = parsed.Path
					evt.Data = parsed.Data
				}

				select {
				case ch <- evt:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			eventType, data = "", ""
		}
	}

	return scanner.Err()
}
