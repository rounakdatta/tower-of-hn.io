package worker

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/hnapi"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/server"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store"
)

const (
	// How many stories to sync from HN's top stories.
	maxStories = 30
	// How many top-level comment threads to fetch per story.
	maxThreadsPerStory = 10
	// How deep to fetch comment trees (0 = root only).
	maxCommentDepth = 5
	// Interval between full re-syncs when SSE is not active.
	pollInterval = 2 * time.Minute
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

// Run performs an initial sync, then enters a polling loop to keep data fresh.
func (s *HNSyncer) Run(ctx context.Context) error {
	s.logger.Info("HN syncer starting, performing initial sync...")

	if err := s.syncTopStories(ctx); err != nil {
		s.logger.Error("Initial sync failed", "error", err)
		// Don't return — still enter the loop to retry
	} else {
		s.logger.Info("Initial sync completed successfully")
	}

	// Notify frontend that stories are available
	s.hub.Broadcast("stories", server.WSMessage{
		Type: "stories_updated",
		Data: map[string]string{"source": "initial_sync"},
	})

	// Polling loop — re-sync periodically
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			s.logger.Info("HN syncer shutting down")
			return ctx.Err()
		case <-ticker.C:
			s.logger.Info("Running periodic sync...")
			if err := s.syncTopStories(ctx); err != nil {
				s.logger.Error("Periodic sync failed", "error", err)
			} else {
				s.hub.Broadcast("stories", server.WSMessage{
					Type: "stories_updated",
					Data: map[string]string{"source": "periodic_sync"},
				})
			}
		}
	}
}

// syncTopStories fetches top stories from HN, stores them, and fetches their comments.
func (s *HNSyncer) syncTopStories(ctx context.Context) error {
	// 1. Fetch top story IDs
	storyIDs, err := s.client.GetTopStories(ctx)
	if err != nil {
		return fmt.Errorf("fetching top stories: %w", err)
	}

	if len(storyIDs) > maxStories {
		storyIDs = storyIDs[:maxStories]
	}

	s.logger.Info("Fetched top story IDs", "count", len(storyIDs))

	// 2. Fetch story details concurrently
	storyItems, err := s.fetcher.FetchItems(ctx, storyIDs)
	if err != nil {
		return fmt.Errorf("fetching story items: %w", err)
	}

	s.logger.Info("Fetched story details", "count", len(storyItems))

	// 3. Convert and upsert stories
	for _, item := range storyItems {
		if item.Type != "story" && item.Type != "" {
			continue
		}
		story := hnapi.ItemToStory(item)
		if err := s.stories.UpsertStory(ctx, story); err != nil {
			s.logger.Warn("Failed to upsert story", "id", item.ID, "error", err)
			continue
		}
	}

	// 4. Update ranks based on the original order from HN
	if err := s.stories.UpdateRanks(ctx, storyIDs); err != nil {
		s.logger.Warn("Failed to update ranks", "error", err)
	}

	// 5. Fetch comments for each story (concurrently, bounded)
	var wg sync.WaitGroup
	sem := make(chan struct{}, 5) // Max 5 stories processed concurrently

	for _, item := range storyItems {
		if item.Type != "story" && item.Type != "" {
			continue
		}
		if len(item.Kids) == 0 {
			continue
		}

		wg.Add(1)
		go func(storyItem *hnapi.Item) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			if err := s.syncStoryComments(ctx, storyItem); err != nil {
				s.logger.Warn("Failed to sync comments for story",
					"story_id", storyItem.ID,
					"title", storyItem.Title,
					"error", err,
				)
			}
		}(item)
	}

	wg.Wait()
	s.logger.Info("Finished syncing all stories and comments")
	return nil
}

// syncStoryComments fetches top-level comments for a story and their subtrees.
func (s *HNSyncer) syncStoryComments(ctx context.Context, storyItem *hnapi.Item) error {
	// Limit to top N kids (top-level comments)
	kids := storyItem.Kids
	if len(kids) > maxThreadsPerStory {
		kids = kids[:maxThreadsPerStory]
	}

	s.logger.Debug("Syncing comments for story",
		"story_id", storyItem.ID,
		"top_level_count", len(kids),
	)

	for _, rootID := range kids {
		if err := s.syncCommentThread(ctx, storyItem.ID, rootID); err != nil {
			s.logger.Warn("Failed to sync comment thread",
				"story_id", storyItem.ID,
				"root_comment_id", rootID,
				"error", err,
			)
			// Continue with other threads
		}
	}

	return nil
}

// syncCommentThread fetches a comment and its reply tree, stores them, and creates a thread.
func (s *HNSyncer) syncCommentThread(ctx context.Context, storyID, rootID int64) error {
	// Fetch the entire thread tree
	items, err := s.fetcher.FetchThread(ctx, rootID)
	if err != nil {
		return fmt.Errorf("fetching thread %d: %w", rootID, err)
	}
	if len(items) == 0 {
		return nil
	}

	// Build a map for depth calculation
	depthMap := make(map[int64]int)
	depthMap[rootID] = 0

	// Sort by ID to process parents before children (IDs are monotonically increasing on HN)
	sort.Slice(items, func(i, j int) bool {
		return items[i].ID < items[j].ID
	})

	// Calculate depths and collect unique participants
	participants := make(map[string]bool)
	var validComments []*domain.Comment

	for _, item := range items {
		if item.Deleted && item.By == "" {
			continue
		}

		depth := 0
		if item.ID == rootID {
			depth = 0
		} else if d, ok := depthMap[item.Parent]; ok {
			depth = d + 1
		}
		depthMap[item.ID] = depth

		// Respect max depth
		if depth > maxCommentDepth {
			continue
		}

		comment := hnapi.ItemToComment(item, storyID, depth)
		if err := s.comments.UpsertComment(ctx, comment); err != nil {
			s.logger.Warn("Failed to upsert comment", "id", item.ID, "error", err)
			continue
		}

		validComments = append(validComments, comment)
		if comment.By != "" && comment.By != "[deleted]" {
			participants[comment.By] = true
		}
	}

	if len(validComments) == 0 {
		return nil
	}

	// Collect participant names
	participantList := make([]string, 0, len(participants))
	for p := range participants {
		participantList = append(participantList, p)
	}

	// Create/update thread entry
	thread := &domain.Thread{
		StoryID:       storyID,
		RootCommentID: rootID,
		CommentCount:  len(validComments),
		Status:        domain.ThreadStatusPending,
		Participants:  participantList,
	}

	if err := s.threads.UpsertThread(ctx, thread); err != nil {
		return fmt.Errorf("upserting thread for root %d: %w", rootID, err)
	}

	return nil
}
