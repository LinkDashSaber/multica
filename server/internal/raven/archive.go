package raven

import (
	"strings"
	"unicode"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Zero-cost trajectory archive helpers (issue #23, ADR-0008): keyword
// fingerprinting and isomorphism judgment are pure functions so the Learned
// archive burns no agent tokens. ArchivesIsomorphic is the single seam to
// swap for an embedding-based similarity later.

// keywordStopwords are tokens too generic to fingerprint a delivery.
var keywordStopwords = map[string]bool{
	"the": true, "and": true, "for": true, "with": true, "that": true,
	"this": true, "from": true, "into": true, "when": true, "then": true,
	"issue": true, "feature": true, "task": true, "fix": true, "add": true,
}

const maxKeywords = 24

// ExtractKeywords builds the keyword fingerprint of a delivery from its
// issue title and description. ASCII words are lowercased tokens of >= 3
// chars; CJK runs are decomposed into character bigrams (no segmenter
// dependency). Order preserved (title first), deduplicated, capped.
func ExtractKeywords(title, description string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(k string) {
		if k == "" || seen[k] || keywordStopwords[k] || len(out) >= maxKeywords {
			return
		}
		seen[k] = true
		out = append(out, k)
	}
	for _, text := range []string{title, description} {
		var word []rune // ascii word run
		var cjk []rune  // CJK run
		flush := func() {
			if len(word) >= 3 {
				add(strings.ToLower(string(word)))
			}
			word = word[:0]
			// ponytail: CJK bigrams instead of real word segmentation;
			// swap ArchivesIsomorphic for embeddings if this gets noisy.
			for i := 0; i+1 < len(cjk); i++ {
				add(string(cjk[i : i+2]))
			}
			if len(cjk) == 1 {
				add(string(cjk))
			}
			cjk = cjk[:0]
		}
		for _, r := range text {
			switch {
			case r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r)):
				word = append(word, r)
			case unicode.Is(unicode.Han, r):
				cjk = append(cjk, r)
			default:
				flush()
			}
		}
		flush()
	}
	return out
}

// trajectoryShape collapses consecutive duplicate states out of a
// comma-joined stage sequence, so a rework loop (running appearing twice
// non-consecutively) still changes the shape but stuttering writes don't.
func trajectoryShape(stageSequence string) string {
	if stageSequence == "" {
		return ""
	}
	parts := strings.Split(stageSequence, ",")
	var out []string
	for _, p := range parts {
		if len(out) == 0 || out[len(out)-1] != p {
			out = append(out, p)
		}
	}
	return strings.Join(out, ",")
}

// ArchivesIsomorphic reports whether two archived deliveries look like the
// same kind of work: same trajectory shape plus enough keyword overlap
// (>= 2 shared, covering >= half of the smaller fingerprint). This is a
// deliberate heuristic seam — replace with embedding similarity when the
// keyword approach proves too coarse.
func ArchivesIsomorphic(a, b db.RavenRequirementArchive) bool {
	if trajectoryShape(a.StageSequence) != trajectoryShape(b.StageSequence) {
		return false
	}
	if len(a.Keywords) == 0 || len(b.Keywords) == 0 {
		return false
	}
	set := make(map[string]bool, len(a.Keywords))
	for _, k := range a.Keywords {
		set[k] = true
	}
	shared := 0
	for _, k := range b.Keywords {
		if set[k] {
			shared++
		}
	}
	minLen := len(a.Keywords)
	if len(b.Keywords) < minLen {
		minLen = len(b.Keywords)
	}
	return shared >= 2 && shared*2 >= minLen
}

// IsomorphicArchives filters all down to entries isomorphic with target,
// including target itself when present. Preserves input order (callers pass
// created_at DESC lists).
// ponytail: O(n) linear scan per lookup; index by fingerprint if archives
// grow past a few thousand per workspace.
func IsomorphicArchives(target db.RavenRequirementArchive, all []db.RavenRequirementArchive) []db.RavenRequirementArchive {
	var out []db.RavenRequirementArchive
	for _, a := range all {
		if a.ID == target.ID || ArchivesIsomorphic(target, a) {
			out = append(out, a)
		}
	}
	return out
}
