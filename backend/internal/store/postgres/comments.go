package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

type CommentStoreImpl struct {
	db *DB
}

func NewCommentStore(db *DB) *CommentStoreImpl {
	return &CommentStoreImpl{db: db}
}

func (c *CommentStoreImpl) UpsertComment(ctx context.Context, comment *domain.Comment) error {
	query := `
		INSERT INTO comments (id, story_id, parent_id, by_user, text_html, text_plain, hn_time, dead, deleted, child_ids, depth, fetched_at)
		VALUES (@id, @story_id, @parent_id, @by_user, @text_html, @text_plain, @hn_time, @dead, @deleted, @child_ids, @depth, NOW())
		ON CONFLICT (id) DO UPDATE SET
			story_id   = EXCLUDED.story_id,
			parent_id  = EXCLUDED.parent_id,
			by_user    = EXCLUDED.by_user,
			text_html  = EXCLUDED.text_html,
			text_plain = EXCLUDED.text_plain,
			hn_time    = EXCLUDED.hn_time,
			dead       = EXCLUDED.dead,
			deleted    = EXCLUDED.deleted,
			child_ids  = EXCLUDED.child_ids,
			depth      = EXCLUDED.depth,
			fetched_at = NOW()`

	args := pgx.NamedArgs{
		"id":         comment.ID,
		"story_id":   comment.StoryID,
		"parent_id":  comment.ParentID,
		"by_user":    comment.By,
		"text_html":  comment.TextHTML,
		"text_plain": comment.TextPlain,
		"hn_time":    comment.HNTime,
		"dead":       comment.Dead,
		"deleted":    comment.Deleted,
		"child_ids":  comment.ChildIDs,
		"depth":      comment.Depth,
	}

	_, err := c.db.Pool.Exec(ctx, query, args)
	if err != nil {
		return fmt.Errorf("upserting comment %d: %w", comment.ID, err)
	}
	return nil
}

func (c *CommentStoreImpl) GetComment(ctx context.Context, id int64) (*domain.Comment, error) {
	query := `
		SELECT id, story_id, parent_id, by_user, text_html, text_plain, hn_time, dead, deleted, child_ids, depth, fetched_at
		FROM comments
		WHERE id = @id`

	cm := &domain.Comment{}
	err := c.db.Pool.QueryRow(ctx, query, pgx.NamedArgs{"id": id}).Scan(
		&cm.ID, &cm.StoryID, &cm.ParentID, &cm.By,
		&cm.TextHTML, &cm.TextPlain, &cm.HNTime,
		&cm.Dead, &cm.Deleted, &cm.ChildIDs, &cm.Depth, &cm.FetchedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("comment %d not found: %w", id, err)
		}
		return nil, fmt.Errorf("getting comment %d: %w", id, err)
	}
	return cm, nil
}

func (c *CommentStoreImpl) GetTopLevelComments(ctx context.Context, storyID int64) ([]*domain.Comment, error) {
	query := `
		SELECT id, story_id, parent_id, by_user, text_html, text_plain, hn_time, dead, deleted, child_ids, depth, fetched_at
		FROM comments
		WHERE story_id = @story_id AND parent_id IS NULL
		ORDER BY hn_time ASC`

	rows, err := c.db.Pool.Query(ctx, query, pgx.NamedArgs{"story_id": storyID})
	if err != nil {
		return nil, fmt.Errorf("querying top-level comments for story %d: %w", storyID, err)
	}
	defer rows.Close()

	return scanComments(rows)
}

func (c *CommentStoreImpl) GetThreadComments(ctx context.Context, rootCommentID int64) ([]*domain.Comment, error) {
	query := `
		WITH RECURSIVE thread AS (
			SELECT id, story_id, parent_id, by_user, text_html, text_plain, hn_time, dead, deleted, child_ids, depth, fetched_at
			FROM comments
			WHERE id = @root_id
			UNION ALL
			SELECT c.id, c.story_id, c.parent_id, c.by_user, c.text_html, c.text_plain, c.hn_time, c.dead, c.deleted, c.child_ids, c.depth, c.fetched_at
			FROM comments c
			INNER JOIN thread t ON c.parent_id = t.id
		)
		SELECT id, story_id, parent_id, by_user, text_html, text_plain, hn_time, dead, deleted, child_ids, depth, fetched_at
		FROM thread
		ORDER BY depth ASC, hn_time ASC`

	rows, err := c.db.Pool.Query(ctx, query, pgx.NamedArgs{"root_id": rootCommentID})
	if err != nil {
		return nil, fmt.Errorf("querying thread comments for root %d: %w", rootCommentID, err)
	}
	defer rows.Close()

	return scanComments(rows)
}

func scanComments(rows pgx.Rows) ([]*domain.Comment, error) {
	var comments []*domain.Comment
	for rows.Next() {
		cm := &domain.Comment{}
		if err := rows.Scan(
			&cm.ID, &cm.StoryID, &cm.ParentID, &cm.By,
			&cm.TextHTML, &cm.TextPlain, &cm.HNTime,
			&cm.Dead, &cm.Deleted, &cm.ChildIDs, &cm.Depth, &cm.FetchedAt,
		); err != nil {
			return nil, fmt.Errorf("scanning comment row: %w", err)
		}
		comments = append(comments, cm)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating comment rows: %w", err)
	}
	return comments, nil
}
