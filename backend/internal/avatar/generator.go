package avatar

import (
	"fmt"
	"hash/fnv"
	"net/url"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

const comicGenBaseURL = "https://gramener.com/comicgen/v1/comic"

// Character templates — each has a distinct look
var characters = []struct {
	Name      string
	Gender    string
	Character string // sub-variant like "englishmoustache", "default"
	FaceStyle string
}{
	{Name: "aavatar", Gender: "male", Character: "englishmoustache", FaceStyle: "thinlines"},
	{Name: "aavatar", Gender: "male", Character: "default", FaceStyle: "thinlines"},
	{Name: "ava", Gender: "female", Character: "default", FaceStyle: "default"},
	{Name: "dee", Gender: "female", Character: "default", FaceStyle: "default"},
	{Name: "dey", Gender: "male", Character: "default", FaceStyle: "default"},
	{Name: "aavatar", Gender: "male", Character: "beardmoustache", FaceStyle: "thinlines"},
}

// Skin tone palette
var faceTones = []string{
	"#eeddc5", "#f5d6b8", "#d4a574", "#c48e5c", "#8d5524", "#6b3f1f",
}

// Shirt color palette — distinct, recognizable
var shirtColors = []string{
	"#66a1ff", "#ff6b6b", "#51cf66", "#ffd43b", "#cc5de8", "#ff922b",
	"#20c997", "#e64980", "#748ffc", "#ff8787",
}

// Pant color palette
var pantColors = []string{
	"#3a4e5c", "#2b3a42", "#4a4a4a", "#1a3a5c", "#2d2d2d", "#3d3d5c",
}

// Attire options
var attires = []string{"formalsuit", "casualshirt", "hoodie"}

// SentimentToEmotion maps sentiment labels to ComicGen emotion values.
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
	"thinking":     "thinking",
	"worried":      "worried",
	"scared":       "scared",
}

// SentimentToPose maps sentiment labels to ComicGen pose values.
var SentimentToPose = map[string]string{
	"happy":        "handsfolded",
	"excited":      "handsup",
	"angry":        "pointingright",
	"sarcastic":    "shrugging",
	"confused":     "scratching",
	"disappointed": "handsfolded",
	"neutral":      "explaining",
	"surprised":    "handsup",
	"sad":          "handsfolded",
	"amused":       "explaining",
	"thinking":     "thinking",
	"worried":      "handsfolded",
	"scared":       "handsup",
}

// hashString returns a stable hash for a string.
func hashString(s string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(s))
	return h.Sum32()
}

// AssignAppearance deterministically assigns a ComicGen character appearance to a username.
// The same username always gets the same character, colors, and attire.
func AssignAppearance(username string) (character, gender, charVariant, faceStyle, faceColor, shirtColor, pantColor, attire string) {
	h := hashString(username)

	charIdx := int(h) % len(characters)
	char := characters[charIdx]

	character = char.Name
	gender = char.Gender
	charVariant = char.Character
	faceStyle = char.FaceStyle
	faceColor = faceTones[int(h/7)%len(faceTones)]
	shirtColor = shirtColors[int(h/13)%len(shirtColors)]
	pantColor = pantColors[int(h/17)%len(pantColors)]
	attire = attires[int(h/23)%len(attires)]

	return
}

// BuildComicGenURL constructs a full ComicGen URL for a character with a specific expression.
func BuildComicGenURL(username, sentimentLabel string, mirror bool) string {
	charName, _, charVariant, faceStyle, faceColor, shirtColor, pantColor, attire := AssignAppearance(username)

	emotion := SentimentToEmotion[sentimentLabel]
	if emotion == "" {
		emotion = "neutral"
	}
	pose := SentimentToPose[sentimentLabel]
	if pose == "" {
		pose = "explaining"
	}

	params := url.Values{}
	params.Set("name", charName)
	params.Set("emotion", emotion)
	params.Set("pose", pose)
	params.Set("attire", attire)
	params.Set("face", faceColor)
	params.Set("shirt", shirtColor)
	params.Set("pant", pantColor)

	if charVariant != "" && charVariant != "default" {
		params.Set("character", charVariant)
	}
	if faceStyle != "" && faceStyle != "default" {
		params.Set("facestyle", faceStyle)
	}
	if mirror {
		params.Set("mirror", "true")
	}

	return fmt.Sprintf("%s?%s", comicGenBaseURL, params.Encode())
}

// Generate creates an AvatarState from a comment's sentiment.
func Generate(commentID int64, username string, sentimentLabel string) *domain.AvatarState {
	charName, _, _, _, _, _, _, _ := AssignAppearance(username)

	emotion := SentimentToEmotion[sentimentLabel]
	if emotion == "" {
		emotion = "neutral"
	}
	pose := SentimentToPose[sentimentLabel]
	if pose == "" {
		pose = "explaining"
	}

	avatarURL := BuildComicGenURL(username, sentimentLabel, false)

	return &domain.AvatarState{
		CommentID: commentID,
		Username:  username,
		Character: charName,
		Emotion:   emotion,
		Pose:      pose,
		AvatarURL: avatarURL,
	}
}
