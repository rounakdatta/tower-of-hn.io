package hnapi

import (
	"html"
	"regexp"
	"strings"
	"time"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

var (
	// tagRe matches HTML tags.
	tagRe = regexp.MustCompile(`<[^>]*>`)
	// whitespaceRe collapses multiple whitespace chars into one.
	whitespaceRe = regexp.MustCompile(`\s+`)
)

// StripHTML removes HTML tags, converts entities, and normalizes whitespace.
// HN comments use <p> for paragraphs, <a> for links, <i> for italic, <pre><code> for code.
func StripHTML(s string) string {
	// Replace <p> and <br> with newlines for readability
	s = strings.ReplaceAll(s, "<p>", "\n\n")
	s = strings.ReplaceAll(s, "</p>", "")
	s = strings.ReplaceAll(s, "<br>", "\n")
	s = strings.ReplaceAll(s, "<br/>", "\n")
	s = strings.ReplaceAll(s, "<br />", "\n")

	// Strip all remaining tags
	s = tagRe.ReplaceAllString(s, "")

	// Decode HTML entities (&amp; → &, &#x27; → ', etc.)
	s = html.UnescapeString(s)

	// Collapse excessive whitespace within lines, preserve paragraph breaks
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = whitespaceRe.ReplaceAllString(strings.TrimSpace(line), " ")
	}
	s = strings.Join(lines, "\n")

	// Collapse more than 2 consecutive newlines
	for strings.Contains(s, "\n\n\n") {
		s = strings.ReplaceAll(s, "\n\n\n", "\n\n")
	}

	return strings.TrimSpace(s)
}

// ItemToStory converts an HN API Item to a domain Story.
func ItemToStory(item *Item) *domain.Story {
	if item == nil {
		return nil
	}
	return &domain.Story{
		ID:          item.ID,
		Title:       item.Title,
		URL:         item.URL,
		Score:       item.Score,
		By:          item.By,
		HNTime:      time.Unix(item.Time, 0),
		Descendants: item.Descendants,
	}
}

// ItemToComment converts an HN API Item to a domain Comment.
// storyID and depth must be provided by the caller (they depend on tree context).
func ItemToComment(item *Item, storyID int64, depth int) *domain.Comment {
	if item == nil {
		return nil
	}

	comment := &domain.Comment{
		ID:       item.ID,
		StoryID:  storyID,
		By:       item.By,
		TextHTML: item.Text,
		HNTime:   time.Unix(item.Time, 0),
		Dead:     item.Dead,
		Deleted:  item.Deleted,
		ChildIDs: item.Kids,
		Depth:    depth,
	}

	// Set parent (0 means top-level, i.e. parent is the story itself)
	if item.Parent != 0 && item.Parent != storyID {
		comment.ParentID = &item.Parent
	}

	// Strip HTML to plain text for TTS
	comment.TextPlain = StripHTML(item.Text)

	// Handle deleted/dead comments
	if item.Deleted {
		comment.By = "[deleted]"
		comment.TextHTML = "[deleted]"
		comment.TextPlain = "[deleted]"
	}
	if item.Dead {
		comment.TextPlain = "[flagged]"
	}

	if comment.ChildIDs == nil {
		comment.ChildIDs = []int64{}
	}

	return comment
}
