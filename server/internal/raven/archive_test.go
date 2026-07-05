package raven

import (
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestExtractKeywords(t *testing.T) {
	got := ExtractKeywords("Sync Marketo leads for Q3", "batch export, the CSV upload")
	want := []string{"sync", "marketo", "leads", "batch", "export", "csv", "upload"}
	if len(got) != len(want) {
		t.Fatalf("keywords: want %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("keywords: want %v, got %v", want, got)
		}
	}

	// CJK text decomposes into bigrams; stopwords and short tokens drop out.
	cjk := ExtractKeywords("同步线索", "")
	wantCJK := []string{"同步", "步线", "线索"}
	if len(cjk) != len(wantCJK) {
		t.Fatalf("cjk keywords: want %v, got %v", wantCJK, cjk)
	}
}

func archiveWith(shape string, keywords ...string) db.RavenRequirementArchive {
	return db.RavenRequirementArchive{StageSequence: shape, Keywords: keywords}
}

func TestArchivesIsomorphic(t *testing.T) {
	a := archiveWith("idea,spec,ready,running,needs_review,merged", "sync", "marketo", "leads", "batch")
	b := archiveWith("idea,spec,ready,running,needs_review,merged", "sync", "marketo", "leads", "export")
	if !ArchivesIsomorphic(a, b) {
		t.Fatal("same shape + 3/4 shared keywords should be isomorphic")
	}

	// Different trajectory shape breaks isomorphism even with keyword overlap.
	c := archiveWith("idea,spec,ready,running,needs_review,running,needs_review,merged",
		"sync", "marketo", "leads", "batch")
	if ArchivesIsomorphic(a, c) {
		t.Fatal("rework loop changes the trajectory shape")
	}

	// Insufficient overlap: only 1 shared keyword.
	d := archiveWith("idea,spec,ready,running,needs_review,merged", "sync", "billing", "invoice", "pdf")
	if ArchivesIsomorphic(a, d) {
		t.Fatal("one shared keyword must not count as isomorphic")
	}

	// Empty fingerprints never match.
	if ArchivesIsomorphic(archiveWith(""), archiveWith("")) {
		t.Fatal("empty keyword sets must not match")
	}
}

func TestTrajectoryShapeCollapsesConsecutiveDuplicates(t *testing.T) {
	if got := trajectoryShape("idea,spec,spec,ready"); got != "idea,spec,ready" {
		t.Fatalf("shape: got %q", got)
	}
	if got := trajectoryShape(""); got != "" {
		t.Fatalf("empty shape: got %q", got)
	}
}
