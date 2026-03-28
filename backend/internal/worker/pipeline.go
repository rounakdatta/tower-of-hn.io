package worker

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/sentiment"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/server"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/tts"
)

const (
	// How many threads to process per poll cycle.
	batchSize = 10
	// How often to check for pending threads.
	pipelineInterval = 5 * time.Second
	// Threads stuck in "processing" for longer than this get reset.
	processingTimeout = 2 * time.Minute
)

// Pipeline processes pending threads: TTS generation → audio stitching.
type Pipeline struct {
	threads   store.ThreadStore
	comments  store.CommentStore
	audio     store.AudioStore
	sentiment store.SentimentStore
	voices    store.VoiceStore
	avatars   store.AvatarStore
	blobs     store.BlobStore
	ttsClient *tts.Client
	analyzer  sentiment.Analyzer
	hub       *server.Hub
	builder   *AudioBuilder
	logger    *slog.Logger
}

func NewPipeline(
	threads store.ThreadStore,
	comments store.CommentStore,
	audio store.AudioStore,
	sentimentStore store.SentimentStore,
	voices store.VoiceStore,
	avatars store.AvatarStore,
	blobs store.BlobStore,
	ttsClient *tts.Client,
	analyzer sentiment.Analyzer,
	hub *server.Hub,
	logger *slog.Logger,
) *Pipeline {
	builder := NewAudioBuilder(comments, voices, audio, sentimentStore, avatars, blobs, ttsClient, analyzer, logger)

	return &Pipeline{
		threads:   threads,
		comments:  comments,
		audio:     audio,
		sentiment: sentimentStore,
		voices:    voices,
		avatars:   avatars,
		blobs:     blobs,
		ttsClient: ttsClient,
		analyzer:  analyzer,
		hub:       hub,
		builder:   builder,
		logger:    logger,
	}
}

// Run starts the pipeline processing loop.
func (p *Pipeline) Run(ctx context.Context) error {
	p.logger.Info("Audio pipeline started, checking for pending threads...")

	// Check TTS service health first
	if err := p.ttsClient.HealthCheck(ctx); err != nil {
		p.logger.Warn("TTS service not available, pipeline will retry", "error", err)
	} else {
		p.logger.Info("TTS service is healthy")
	}

	// Process immediately on start, then periodically
	p.processBatch(ctx)

	ticker := time.NewTicker(pipelineInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			p.logger.Info("Audio pipeline shutting down")
			return ctx.Err()
		case <-ticker.C:
			p.processBatch(ctx)
		}
	}
}

// processBatch picks up pending threads and processes them.
func (p *Pipeline) processBatch(ctx context.Context) {
	threads, err := p.threads.GetPendingThreads(ctx, batchSize)
	if err != nil {
		p.logger.Error("Failed to fetch pending threads", "error", err)
		return
	}

	if len(threads) == 0 {
		return
	}

	p.logger.Info("Processing pending threads", "count", len(threads))

	for _, thread := range threads {
		if ctx.Err() != nil {
			return
		}
		p.processThread(ctx, thread)
	}
}

// processThread handles a single thread: mark processing → build audio → mark ready.
func (p *Pipeline) processThread(ctx context.Context, thread *domain.Thread) {
	// Mark as processing
	if err := p.threads.SetStatus(ctx, thread.ID, domain.ThreadStatusProcessing); err != nil {
		p.logger.Error("Failed to set thread status to processing", "thread_id", thread.ID, "error", err)
		return
	}

	// Notify frontend
	p.hub.Broadcast(fmt.Sprintf("story:%d", thread.StoryID), server.WSMessage{
		Type: "thread_processing",
		Data: map[string]int64{"story_id": thread.StoryID, "thread_id": thread.ID},
	})

	// Build the audio
	durationMs, err := p.builder.BuildThreadAudio(ctx, thread)
	if err != nil {
		p.logger.Error("Failed to build thread audio",
			"thread_id", thread.ID,
			"error", err,
		)
		p.threads.SetStatus(ctx, thread.ID, domain.ThreadStatusError)
		return
	}

	// Mark as ready
	if err := p.threads.SetStatus(ctx, thread.ID, domain.ThreadStatusReady); err != nil {
		p.logger.Error("Failed to set thread status to ready", "thread_id", thread.ID, "error", err)
		return
	}

	// Notify frontend that audio is ready
	p.hub.Broadcast(fmt.Sprintf("story:%d", thread.StoryID), server.WSMessage{
		Type: "thread_ready",
		Data: map[string]interface{}{
			"story_id":    thread.StoryID,
			"thread_id":   thread.ID,
			"duration_ms": durationMs,
		},
	})

	p.logger.Info("Thread audio ready",
		"thread_id", thread.ID,
		"duration_ms", durationMs,
	)
}

