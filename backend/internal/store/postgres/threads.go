package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

type ThreadStoreImpl struct {
	db *DB
}

func NewThreadStore(db *DB) *ThreadStoreImpl {
	return &ThreadStoreImpl{db: db}
}

func (t *ThreadStoreImpl) UpsertThread(ctx context.Context, thread *domain.Thread) error {
	query := `
		INSERT INTO threads (story_id, root_comment_id, comment_count, status, updated_at)
		VALUES (@story_id, @root_comment_id, @comment_count, @status, NOW())
		ON CONFLICT (root_comment_id) DO UPDATE SET
			comment_count = EXCLUDED.comment_count,
			status        = EXCLUDED.status,
			updated_at    = NOW()
		RETURNING id`

	err := t.db.Pool.QueryRow(ctx, query, pgx.NamedArgs{
		"story_id":        thread.StoryID,
		"root_comment_id": thread.RootCommentID,
		"comment_count":   thread.CommentCount,
		"status":          thread.Status,
	}).Scan(&thread.ID)
	if err != nil {
		return fmt.Errorf("upserting thread for root comment %d: %w", thread.RootCommentID, err)
	}
	return nil
}

func (t *ThreadStoreImpl) GetThread(ctx context.Context, id int64) (*domain.Thread, error) {
	query := `
		SELECT id, story_id, root_comment_id, comment_count, status, updated_at
		FROM threads
		WHERE id = @id`

	th := &domain.Thread{}
	err := t.db.Pool.QueryRow(ctx, query, pgx.NamedArgs{"id": id}).Scan(
		&th.ID, &th.StoryID, &th.RootCommentID,
		&th.CommentCount, &th.Status, &th.UpdatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("thread %d not found: %w", id, err)
		}
		return nil, fmt.Errorf("getting thread %d: %w", id, err)
	}
	return th, nil
}

func (t *ThreadStoreImpl) GetThreadsForStory(ctx context.Context, storyID int64) ([]*domain.Thread, error) {
	query := `
		SELECT t.id, t.story_id, t.root_comment_id, t.comment_count, t.status, t.updated_at,
		       c.by_user, c.text_plain
		FROM threads t
		JOIN comments c ON c.id = t.root_comment_id
		WHERE t.story_id = @story_id
		ORDER BY t.comment_count DESC`

	rows, err := t.db.Pool.Query(ctx, query, pgx.NamedArgs{"story_id": storyID})
	if err != nil {
		return nil, fmt.Errorf("querying threads for story %d: %w", storyID, err)
	}
	defer rows.Close()

	threads := make([]*domain.Thread, 0)
	for rows.Next() {
		th := &domain.Thread{}
		var rootBy, rootText string
		if err := rows.Scan(
			&th.ID, &th.StoryID, &th.RootCommentID,
			&th.CommentCount, &th.Status, &th.UpdatedAt,
			&rootBy, &rootText,
		); err != nil {
			return nil, fmt.Errorf("scanning thread row: %w", err)
		}
		th.RootComment = &domain.Comment{
			ID:        th.RootCommentID,
			By:        rootBy,
			TextPlain: rootText,
		}
		threads = append(threads, th)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating thread rows: %w", err)
	}
	return threads, nil
}

func (t *ThreadStoreImpl) GetPendingThreads(ctx context.Context, limit int) ([]*domain.Thread, error) {
	query := `
		SELECT id, story_id, root_comment_id, comment_count, status, updated_at
		FROM threads
		WHERE status = 'pending'
		ORDER BY updated_at ASC
		LIMIT @limit`

	rows, err := t.db.Pool.Query(ctx, query, pgx.NamedArgs{"limit": limit})
	if err != nil {
		return nil, fmt.Errorf("querying pending threads: %w", err)
	}
	defer rows.Close()

	return scanThreads(rows)
}

func (t *ThreadStoreImpl) SetStatus(ctx context.Context, threadID int64, status domain.ThreadStatus) error {
	query := `
		UPDATE threads
		SET status = @status, updated_at = NOW()
		WHERE id = @id`

	tag, err := t.db.Pool.Exec(ctx, query, pgx.NamedArgs{
		"id":     threadID,
		"status": status,
	})
	if err != nil {
		return fmt.Errorf("setting status for thread %d: %w", threadID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("thread %d not found", threadID)
	}
	return nil
}

func scanThreads(rows pgx.Rows) ([]*domain.Thread, error) {
	var threads []*domain.Thread
	for rows.Next() {
		th := &domain.Thread{}
		if err := rows.Scan(
			&th.ID, &th.StoryID, &th.RootCommentID,
			&th.CommentCount, &th.Status, &th.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scanning thread row: %w", err)
		}
		threads = append(threads, th)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating thread rows: %w", err)
	}
	return threads, nil
}
