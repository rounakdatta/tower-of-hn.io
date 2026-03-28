package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

type StoryStoreImpl struct {
	db *DB
}

func NewStoryStore(db *DB) *StoryStoreImpl {
	return &StoryStoreImpl{db: db}
}

func (s *StoryStoreImpl) UpsertStory(ctx context.Context, story *domain.Story) error {
	query := `
		INSERT INTO stories (id, title, url, score, by_user, hn_time, descendants, rank, fetched_at, updated_at)
		VALUES (@id, @title, @url, @score, @by_user, @hn_time, @descendants, @rank, NOW(), NOW())
		ON CONFLICT (id) DO UPDATE SET
			title       = EXCLUDED.title,
			url         = EXCLUDED.url,
			score       = EXCLUDED.score,
			by_user     = EXCLUDED.by_user,
			hn_time     = EXCLUDED.hn_time,
			descendants = EXCLUDED.descendants,
			updated_at  = NOW()`

	args := pgx.NamedArgs{
		"id":          story.ID,
		"title":       story.Title,
		"url":         story.URL,
		"score":       story.Score,
		"by_user":     story.By,
		"hn_time":     story.HNTime,
		"descendants": story.Descendants,
		"rank":        story.Rank,
	}

	_, err := s.db.Pool.Exec(ctx, query, args)
	if err != nil {
		return fmt.Errorf("upserting story %d: %w", story.ID, err)
	}
	return nil
}

func (s *StoryStoreImpl) GetTopStories(ctx context.Context, limit int) ([]*domain.Story, error) {
	query := `
		SELECT id, title, url, score, by_user, hn_time, descendants, rank, fetched_at, updated_at
		FROM stories
		WHERE rank IS NOT NULL
		ORDER BY rank ASC
		LIMIT @limit`

	rows, err := s.db.Pool.Query(ctx, query, pgx.NamedArgs{"limit": limit})
	if err != nil {
		return nil, fmt.Errorf("querying top stories: %w", err)
	}
	defer rows.Close()

	stories := make([]*domain.Story, 0)
	for rows.Next() {
		st := &domain.Story{}
		if err := rows.Scan(
			&st.ID, &st.Title, &st.URL, &st.Score,
			&st.By, &st.HNTime, &st.Descendants, &st.Rank,
			&st.FetchedAt, &st.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scanning story row: %w", err)
		}
		stories = append(stories, st)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating story rows: %w", err)
	}
	return stories, nil
}

func (s *StoryStoreImpl) GetStory(ctx context.Context, id int64) (*domain.Story, error) {
	query := `
		SELECT id, title, url, score, by_user, hn_time, descendants, rank, fetched_at, updated_at
		FROM stories
		WHERE id = @id`

	st := &domain.Story{}
	err := s.db.Pool.QueryRow(ctx, query, pgx.NamedArgs{"id": id}).Scan(
		&st.ID, &st.Title, &st.URL, &st.Score,
		&st.By, &st.HNTime, &st.Descendants, &st.Rank,
		&st.FetchedAt, &st.UpdatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("story %d not found: %w", id, err)
		}
		return nil, fmt.Errorf("getting story %d: %w", id, err)
	}
	return st, nil
}

func (s *StoryStoreImpl) UpdateRanks(ctx context.Context, rankedIDs []int64) error {
	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Clear all existing ranks.
	_, err = tx.Exec(ctx, `UPDATE stories SET rank = NULL WHERE rank IS NOT NULL`)
	if err != nil {
		return fmt.Errorf("clearing ranks: %w", err)
	}

	// Set ranks based on position in the input slice (1-indexed).
	for i, id := range rankedIDs {
		rank := i + 1
		_, err = tx.Exec(ctx,
			`UPDATE stories SET rank = @rank, updated_at = NOW() WHERE id = @id`,
			pgx.NamedArgs{"rank": rank, "id": id},
		)
		if err != nil {
			return fmt.Errorf("setting rank %d for story %d: %w", rank, id, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing rank update: %w", err)
	}
	return nil
}
