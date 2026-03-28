package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

type SentimentStoreImpl struct {
	db *DB
}

func NewSentimentStore(db *DB) *SentimentStoreImpl {
	return &SentimentStoreImpl{db: db}
}

func (s *SentimentStoreImpl) GetSentiment(ctx context.Context, commentID int64) (*domain.Sentiment, error) {
	query := `
		SELECT comment_id, sentiment, confidence, emotion, model_version, analyzed_at
		FROM comment_sentiments
		WHERE comment_id = @comment_id`

	sent := &domain.Sentiment{}
	err := s.db.Pool.QueryRow(ctx, query, pgx.NamedArgs{"comment_id": commentID}).Scan(
		&sent.CommentID, &sent.Label, &sent.Confidence,
		&sent.Emotion, &sent.ModelVersion, &sent.AnalyzedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("sentiment for comment %d not found: %w", commentID, err)
		}
		return nil, fmt.Errorf("getting sentiment for comment %d: %w", commentID, err)
	}
	return sent, nil
}

func (s *SentimentStoreImpl) UpsertSentiment(ctx context.Context, sent *domain.Sentiment) error {
	query := `
		INSERT INTO comment_sentiments (comment_id, sentiment, confidence, emotion, model_version, analyzed_at)
		VALUES (@comment_id, @sentiment, @confidence, @emotion, @model_version, NOW())
		ON CONFLICT (comment_id) DO UPDATE SET
			sentiment     = EXCLUDED.sentiment,
			confidence    = EXCLUDED.confidence,
			emotion       = EXCLUDED.emotion,
			model_version = EXCLUDED.model_version,
			analyzed_at   = NOW()`

	_, err := s.db.Pool.Exec(ctx, query, pgx.NamedArgs{
		"comment_id":    sent.CommentID,
		"sentiment":     sent.Label,
		"confidence":    sent.Confidence,
		"emotion":       sent.Emotion,
		"model_version": sent.ModelVersion,
	})
	if err != nil {
		return fmt.Errorf("upserting sentiment for comment %d: %w", sent.CommentID, err)
	}
	return nil
}

func (s *SentimentStoreImpl) GetMissing(ctx context.Context, commentIDs []int64) ([]int64, error) {
	if len(commentIDs) == 0 {
		return nil, nil
	}

	query := `
		SELECT id
		FROM UNNEST(@ids::BIGINT[]) AS id
		WHERE id NOT IN (
			SELECT comment_id FROM comment_sentiments
		)`

	rows, err := s.db.Pool.Query(ctx, query, pgx.NamedArgs{"ids": commentIDs})
	if err != nil {
		return nil, fmt.Errorf("querying missing sentiments: %w", err)
	}
	defer rows.Close()

	var missing []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scanning missing sentiment id: %w", err)
		}
		missing = append(missing, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating missing sentiment rows: %w", err)
	}
	return missing, nil
}
