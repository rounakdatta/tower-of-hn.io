package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type VoiceStoreImpl struct {
	db *DB
}

func NewVoiceStore(db *DB) *VoiceStoreImpl {
	return &VoiceStoreImpl{db: db}
}

func (v *VoiceStoreImpl) GetVoice(ctx context.Context, username string) (string, error) {
	query := `
		SELECT voice_id
		FROM voice_assignments
		WHERE username = @username`

	var voiceID string
	err := v.db.Pool.QueryRow(ctx, query, pgx.NamedArgs{"username": username}).Scan(&voiceID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", fmt.Errorf("voice assignment for user %q not found: %w", username, err)
		}
		return "", fmt.Errorf("getting voice for user %q: %w", username, err)
	}
	return voiceID, nil
}

func (v *VoiceStoreImpl) AssignVoice(ctx context.Context, username, voiceID string) error {
	query := `
		INSERT INTO voice_assignments (username, voice_id, assigned_at)
		VALUES (@username, @voice_id, NOW())
		ON CONFLICT (username) DO NOTHING`

	_, err := v.db.Pool.Exec(ctx, query, pgx.NamedArgs{
		"username": username,
		"voice_id": voiceID,
	})
	if err != nil {
		return fmt.Errorf("assigning voice %q to user %q: %w", voiceID, username, err)
	}
	return nil
}
