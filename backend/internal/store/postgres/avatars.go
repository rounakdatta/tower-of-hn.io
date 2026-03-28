package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

type AvatarStoreImpl struct {
	db *DB
}

func NewAvatarStore(db *DB) *AvatarStoreImpl {
	return &AvatarStoreImpl{db: db}
}

func (a *AvatarStoreImpl) GetAvatarState(ctx context.Context, commentID int64) (*domain.AvatarState, error) {
	query := `
		SELECT comment_id, username, character, emotion, pose, avatar_url, created_at
		FROM avatar_states
		WHERE comment_id = @comment_id`

	av := &domain.AvatarState{}
	err := a.db.Pool.QueryRow(ctx, query, pgx.NamedArgs{"comment_id": commentID}).Scan(
		&av.CommentID, &av.Username, &av.Character,
		&av.Emotion, &av.Pose, &av.AvatarURL, &av.CreatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("avatar state for comment %d not found: %w", commentID, err)
		}
		return nil, fmt.Errorf("getting avatar state for comment %d: %w", commentID, err)
	}
	return av, nil
}

func (a *AvatarStoreImpl) UpsertAvatarState(ctx context.Context, av *domain.AvatarState) error {
	query := `
		INSERT INTO avatar_states (comment_id, username, character, emotion, pose, avatar_url, created_at)
		VALUES (@comment_id, @username, @character, @emotion, @pose, @avatar_url, NOW())
		ON CONFLICT (comment_id) DO UPDATE SET
			username   = EXCLUDED.username,
			character  = EXCLUDED.character,
			emotion    = EXCLUDED.emotion,
			pose       = EXCLUDED.pose,
			avatar_url = EXCLUDED.avatar_url,
			created_at = NOW()`

	_, err := a.db.Pool.Exec(ctx, query, pgx.NamedArgs{
		"comment_id": av.CommentID,
		"username":   av.Username,
		"character":  av.Character,
		"emotion":    av.Emotion,
		"pose":       av.Pose,
		"avatar_url": av.AvatarURL,
	})
	if err != nil {
		return fmt.Errorf("upserting avatar state for comment %d: %w", av.CommentID, err)
	}
	return nil
}
