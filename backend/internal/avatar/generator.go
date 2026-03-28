package avatar

import (
	"fmt"
	"hash/fnv"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

const comicGenBaseURL = "https://gramener.com/comicgen/v1/comic"

// SentimentToEmotion maps sentiment labels to ComicGen emotion values.
var SentimentToEmotion = map[string]string{
	domain.SentimentHappy:        "happy",
	domain.SentimentExcited:      "excited",
	domain.SentimentAngry:        "angry",
	domain.SentimentSarcastic:    "smirk",
	domain.SentimentConfused:     "confused",
	domain.SentimentDisappointed: "sad",
	domain.SentimentNeutral:      "neutral",
	domain.SentimentSurprised:    "surprised",
	domain.SentimentSad:          "sad",
	domain.SentimentAmused:       "smile",
	domain.SentimentThinking:     "thinking",
}

var characters = []string{"aavatar", "ava"}

var poses = map[string]string{
	domain.SentimentHappy:        "handsfolded",
	domain.SentimentExcited:      "handsup",
	domain.SentimentAngry:        "pointingright",
	domain.SentimentSarcastic:    "handsfolded",
	domain.SentimentConfused:     "scratching",
	domain.SentimentNeutral:      "explaining",
	domain.SentimentThinking:     "thinking",
	domain.SentimentSurprised:    "handsup",
	domain.SentimentSad:          "handsfolded",
	domain.SentimentAmused:       "explaining",
	domain.SentimentDisappointed: "handsfolded",
}

// Generate creates an AvatarState from a comment's sentiment.
func Generate(commentID int64, username string, sentimentLabel string) *domain.AvatarState {
	emotion := SentimentToEmotion[sentimentLabel]
	if emotion == "" {
		emotion = "neutral"
	}

	pose := poses[sentimentLabel]
	if pose == "" {
		pose = "explaining"
	}

	// Deterministic character per user
	h := fnv.New32a()
	h.Write([]byte(username))
	character := characters[int(h.Sum32())%len(characters)]

	avatarURL := fmt.Sprintf("%s?name=%s&emotion=%s&pose=%s", comicGenBaseURL, character, emotion, pose)

	return &domain.AvatarState{
		CommentID: commentID,
		Username:  username,
		Character: character,
		Emotion:   emotion,
		Pose:      pose,
		AvatarURL: avatarURL,
	}
}
