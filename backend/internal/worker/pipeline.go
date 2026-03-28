package worker

import (
	"context"
	"log/slog"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/sentiment"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/server"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/tts"
)

// Pipeline processes pending threads: sentiment analysis → TTS → audio stitching.
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
		logger:    logger,
	}
}

func (p *Pipeline) Run(ctx context.Context) error {
	// TODO: Implement the processing loop
	// 1. Poll for pending threads
	// 2. For each: load comments, analyze sentiment, generate TTS, stitch audio
	// 3. Update thread status to 'ready'
	// 4. Notify frontend via WebSocket
	p.logger.Info("Audio pipeline worker started")
	<-ctx.Done()
	return ctx.Err()
}
