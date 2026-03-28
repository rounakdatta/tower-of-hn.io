package worker

import (
	"context"
	"log/slog"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/hnapi"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/server"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store"
)

// HNSyncer streams updates from HN and writes them to the database.
type HNSyncer struct {
	client   *hnapi.Client
	fetcher  *hnapi.Fetcher
	streamer *hnapi.Streamer
	stories  store.StoryStore
	comments store.CommentStore
	threads  store.ThreadStore
	hub      *server.Hub
	logger   *slog.Logger
}

func NewHNSyncer(
	client *hnapi.Client,
	fetcher *hnapi.Fetcher,
	streamer *hnapi.Streamer,
	stories store.StoryStore,
	comments store.CommentStore,
	threads store.ThreadStore,
	hub *server.Hub,
	logger *slog.Logger,
) *HNSyncer {
	return &HNSyncer{
		client:   client,
		fetcher:  fetcher,
		streamer: streamer,
		stories:  stories,
		comments: comments,
		threads:  threads,
		hub:      hub,
		logger:   logger,
	}
}

func (s *HNSyncer) Run(ctx context.Context) error {
	// TODO: Implement the sync loop
	// 1. Subscribe to HN /topstories SSE stream
	// 2. On change: fetch new/changed stories, upsert to DB
	// 3. For each story: fetch top-level comments, create threads
	// 4. Notify frontend via WebSocket
	s.logger.Info("HN syncer worker started")
	<-ctx.Done()
	return ctx.Err()
}
