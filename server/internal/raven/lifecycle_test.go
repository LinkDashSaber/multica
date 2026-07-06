package raven

import "testing"

// TestCancelledIsReachableFromInProgress asserts issue #32's rule: any
// in-progress state can abort to cancelled, delivered/settled states cannot,
// and cancelled is terminal.
func TestCancelledIsReachableFromInProgress(t *testing.T) {
	cancellable := []State{
		StateIdea, StateSpec, StateReady, StateRunning, StateNeedsReview, StateNeedsHuman,
	}
	for _, s := range cancellable {
		if !CanTransition(s, StateCancelled) {
			t.Errorf("%s should be cancellable", s)
		}
	}

	notCancellable := []State{StateMerged, StateObserved, StateLearned, StateCancelled}
	for _, s := range notCancellable {
		if CanTransition(s, StateCancelled) {
			t.Errorf("%s must not be cancellable", s)
		}
	}
}

func TestCancelledIsTerminalAndValid(t *testing.T) {
	if !ValidState(StateCancelled) {
		t.Fatal("cancelled must be a valid state")
	}
	if got := NextStates(StateCancelled); len(got) != 0 {
		t.Fatalf("cancelled must be terminal, got successors %v", got)
	}
	if got := IssueStatusFor(StateCancelled); got != "cancelled" {
		t.Fatalf("cancelled should project to issue status cancelled, got %s", got)
	}
}
