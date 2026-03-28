package avatar

import (
	"fmt"
	"hash/fnv"
	"net/url"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/tts"
)

const comicGenBaseURL = "https://gramener.com/comicgen/v1/comic"

// Verified working ComicGen configurations (March 2026):
// - name=aavatar with gender=male, character=englishmoustache, facestyle=thinlines, attire=formalsuit
// - name=aavatar with gender=female, character=shorthair, facestyle=thinlines, attire=formalsuit
// - Emotions: happy, sad, angry, surprised, confused, neutral, smirk, excited, worried (NOT thinking)
// - Poses: handsfolded, pointingright, thinking

// Skin tone palette — diverse
var faceTones = []string{
	"#eeddc5", "#f5d6b8", "#d4a574", "#c48e5c", "#8d5524", "#6b3f1f",
}

// Shirt color palette — distinct and recognizable
var shirtColors = []string{
	"#66a1ff", "#ff6b6b", "#51cf66", "#ffd43b", "#cc5de8", "#ff922b",
	"#20c997", "#e64980", "#748ffc", "#ff8787",
}

// Pant colors
var pantColors = []string{
	"#3a4e5c", "#2b3a42", "#4a4a4a", "#1a3a5c", "#2d2d2d", "#3d3d5c",
}

// SentimentToEmotion maps sentiment labels to verified ComicGen emotions.
var SentimentToEmotion = map[string]string{
	"happy":        "happy",
	"excited":      "excited",
	"angry":        "angry",
	"sarcastic":    "smirk",
	"confused":     "confused",
	"disappointed": "sad",
	"neutral":      "neutral",
	"surprised":    "surprised",
	"sad":          "sad",
	"amused":       "smirk",
	"thinking":     "confused", // "thinking" emotion doesn't render — use "confused" face
	"worried":      "worried",
	"scared":       "surprised",
}

// SentimentToPose maps sentiment labels to verified ComicGen poses.
var SentimentToPose = map[string]string{
	"happy":        "handsfolded",
	"excited":      "pointingright",
	"angry":        "pointingright",
	"sarcastic":    "handsfolded",
	"confused":     "thinking",
	"disappointed": "handsfolded",
	"neutral":      "handsfolded",
	"surprised":    "pointingright",
	"sad":          "handsfolded",
	"amused":       "handsfolded",
	"thinking":     "thinking",
	"worried":      "handsfolded",
	"scared":       "pointingright",
}

func hashString(s string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(s))
	return h.Sum32()
}

// GenderFromVoice returns "male" or "female" based on the voice ID prefix.
func GenderFromVoice(voiceID string) string {
	if len(voiceID) >= 2 {
		prefix := voiceID[:2]
		if prefix == "af" || prefix == "bf" {
			return "female"
		}
	}
	return "male"
}

// BuildComicGenURL constructs a ComicGen URL for a character with the correct
// gender (synced with TTS voice) and sentiment-driven expression.
func BuildComicGenURL(username, voiceID, sentimentLabel string) string {
	gender := GenderFromVoice(voiceID)

	// Character config — synced with voice gender
	character := "englishmoustache"
	if gender == "female" {
		character = "shorthair"
	}

	// Emotion and pose from sentiment (with safe defaults)
	emotion := SentimentToEmotion[sentimentLabel]
	if emotion == "" {
		emotion = "neutral"
	}
	pose := SentimentToPose[sentimentLabel]
	if pose == "" {
		pose = "handsfolded"
	}

	// Deterministic colors from username
	h := hashString(username)
	faceColor := faceTones[int(h)%len(faceTones)]
	shirtColor := shirtColors[int(h/7)%len(shirtColors)]
	pantColor := pantColors[int(h/13)%len(pantColors)]

	params := url.Values{}
	params.Set("name", "aavatar")
	params.Set("gender", gender)
	params.Set("character", character)
	params.Set("facestyle", "thinlines")
	params.Set("attire", "formalsuit")
	params.Set("emotion", emotion)
	params.Set("pose", pose)
	params.Set("face", faceColor)
	params.Set("shirt", shirtColor)
	params.Set("pant", pantColor)

	return fmt.Sprintf("%s?%s", comicGenBaseURL, params.Encode())
}

// Generate creates an AvatarState for a comment with gender-synced appearance.
func Generate(commentID int64, username, voiceID, sentimentLabel string) *domain.AvatarState {
	// If no voice ID provided, derive one
	if voiceID == "" {
		voiceID = tts.AssignVoice(username)
	}

	emotion := SentimentToEmotion[sentimentLabel]
	if emotion == "" {
		emotion = "neutral"
	}
	pose := SentimentToPose[sentimentLabel]
	if pose == "" {
		pose = "handsfolded"
	}

	return &domain.AvatarState{
		CommentID: commentID,
		Username:  username,
		Character: "aavatar",
		Emotion:   emotion,
		Pose:      pose,
		AvatarURL: BuildComicGenURL(username, voiceID, sentimentLabel),
	}
}
