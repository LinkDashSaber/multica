package raven

import (
	"sort"
	"strings"
	"unicode"
)

// ponytail: deterministic keyword-overlap scoring for workflow recommendation
// v1 (issue #9) — no LLM. Upgrade path: embed issue/workflow text and rank by
// cosine similarity when keyword overlap proves too coarse.

// tokenizeMatchText lowercases the text and emits ASCII word tokens (len >= 2)
// plus CJK bigrams, so both English and Chinese requirement text can overlap
// with workflow names/descriptions.
func tokenizeMatchText(s string) map[string]struct{} {
	tokens := make(map[string]struct{})
	var word []rune
	var prevCJK rune
	flush := func() {
		if len(word) >= 2 {
			tokens[string(word)] = struct{}{}
		}
		word = word[:0]
	}
	for _, r := range strings.ToLower(s) {
		switch {
		case unicode.Is(unicode.Han, r):
			flush()
			if prevCJK != 0 {
				tokens[string([]rune{prevCJK, r})] = struct{}{}
			}
			prevCJK = r
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			prevCJK = 0
			word = append(word, r)
		default:
			prevCJK = 0
			flush()
		}
	}
	flush()
	return tokens
}

// ScoreWorkflowMatch scores how well a workflow (name + description) matches
// the issue text. Returns a 0..1 score — the fraction of the workflow's
// tokens found in the issue text — and the matched tokens, sorted for a
// stable human-readable reason string.
func ScoreWorkflowMatch(issueText, workflowText string) (float64, []string) {
	issueTokens := tokenizeMatchText(issueText)
	wfTokens := tokenizeMatchText(workflowText)
	if len(wfTokens) == 0 {
		return 0, nil
	}
	var matched []string
	for tok := range wfTokens {
		if _, ok := issueTokens[tok]; ok {
			matched = append(matched, tok)
		}
	}
	sort.Strings(matched)
	return float64(len(matched)) / float64(len(wfTokens)), matched
}
