package store

import (
	"context"
	"io"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

type StoryStore interface {
	UpsertStory(ctx context.Context, story *domain.Story) error
	GetTopStories(ctx context.Context, limit int) ([]*domain.Story, error)
	GetStory(ctx context.Context, id int64) (*domain.Story, error)
	UpdateRanks(ctx context.Context, rankedIDs []int64) error
}

type CommentStore interface {
	UpsertComment(ctx context.Context, comment *domain.Comment) error
	GetComment(ctx context.Context, id int64) (*domain.Comment, error)
	GetTopLevelComments(ctx context.Context, storyID int64) ([]*domain.Comment, error)
	GetThreadComments(ctx context.Context, rootCommentID int64) ([]*domain.Comment, error)
}

type SentimentStore interface {
	GetSentiment(ctx context.Context, commentID int64) (*domain.Sentiment, error)
	UpsertSentiment(ctx context.Context, s *domain.Sentiment) error
	GetMissing(ctx context.Context, commentIDs []int64) ([]int64, error)
}

type AudioStore interface {
	GetThreadAudio(ctx context.Context, threadID int64) (*domain.ThreadAudio, error)
	UpsertSegment(ctx context.Context, seg *domain.AudioSegment) error
	UpsertThreadAudio(ctx context.Context, ta *domain.ThreadAudio) error
	GetSegments(ctx context.Context, threadID int64) ([]*domain.AudioSegment, error)
}

type ThreadStore interface {
	UpsertThread(ctx context.Context, t *domain.Thread) error
	GetThread(ctx context.Context, id int64) (*domain.Thread, error)
	GetThreadsForStory(ctx context.Context, storyID int64) ([]*domain.Thread, error)
	GetPendingThreads(ctx context.Context, limit int) ([]*domain.Thread, error)
	SetStatus(ctx context.Context, threadID int64, status domain.ThreadStatus) error
}

type VoiceStore interface {
	GetVoice(ctx context.Context, username string) (string, error)
	AssignVoice(ctx context.Context, username, voiceID string) error
}

type AvatarStore interface {
	GetAvatarState(ctx context.Context, commentID int64) (*domain.AvatarState, error)
	UpsertAvatarState(ctx context.Context, a *domain.AvatarState) error
}

// BlobStore abstracts audio file storage (local FS now, S3/R2 later).
type BlobStore interface {
	Write(ctx context.Context, key string, data []byte) error
	Read(ctx context.Context, key string) (io.ReadCloser, error)
	URL(ctx context.Context, key string) (string, error)
	Delete(ctx context.Context, key string) error
}
