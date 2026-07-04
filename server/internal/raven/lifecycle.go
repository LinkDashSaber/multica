// Package raven holds Raven domain logic grown inside the multica fork
// (ADR-0001). It stays cleanly separated from multica's execution-layer
// code so a future split remains possible.
package raven

// State is one of the nine requirement lifecycle states (see CONTEXT.md).
type State string

const (
	StateIdea        State = "idea"
	StateSpec        State = "spec"
	StateReady       State = "ready"
	StateRunning     State = "running"
	StateNeedsReview State = "needs_review"
	StateNeedsHuman  State = "needs_human"
	StateMerged      State = "merged"
	StateObserved    State = "observed"
	StateLearned     State = "learned"
)

// transitions defines every legal state change. v1 active path runs
// Idea → … → Merged; Observed/Learned exist in the schema with manual
// advancement only (产品定义 §3).
var transitions = map[State][]State{
	StateIdea:  {StateSpec},
	StateSpec:  {StateReady},
	StateReady: {StateRunning},
	// A run either reaches a gate (needs_review) or gets stuck on a
	// question only a human can answer (needs_human).
	StateRunning: {StateNeedsReview, StateNeedsHuman},
	// Gate verdict: approve → merged, reject → back to running (same run,
	// carries the rejection reason), or escalate to a human decision.
	StateNeedsReview: {StateMerged, StateRunning, StateNeedsHuman},
	// Human unblocks the run.
	StateNeedsHuman: {StateRunning},
	StateMerged:     {StateObserved},
	StateObserved:   {StateLearned},
	StateLearned:    {},
}

// ValidState reports whether s is one of the nine lifecycle states.
func ValidState(s State) bool {
	_, ok := transitions[s]
	return ok
}

// CanTransition reports whether from → to is a legal lifecycle transition.
func CanTransition(from, to State) bool {
	for _, next := range transitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// NextStates returns the legal successor states of s.
func NextStates(s State) []State {
	return transitions[s]
}

// IssueStatusFor projects a lifecycle state onto the multica issue board
// column. One-way: board drag-and-drop never writes back into the lifecycle.
func IssueStatusFor(s State) string {
	switch s {
	case StateIdea:
		return "backlog"
	case StateSpec, StateReady:
		return "todo"
	case StateRunning:
		return "in_progress"
	case StateNeedsReview:
		return "in_review"
	case StateNeedsHuman:
		return "blocked"
	case StateMerged, StateObserved, StateLearned:
		return "done"
	default:
		return "backlog"
	}
}
