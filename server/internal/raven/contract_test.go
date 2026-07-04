package raven

import (
	"encoding/json"
	"testing"
)

// Stage declarations accept both the object form (with optional description)
// and the legacy bare-string form (issue #15).
func TestParseContractStageForms(t *testing.T) {
	raw := json.RawMessage(`{
		"stages": [
			{"name": "clarify", "description": "澄清拍板问题"},
			"execute"
		],
		"gates": [{"name": "g", "after_stage": "execute"}],
		"budget": {"max_tokens": 100}
	}`)
	c, err := ParseContract(raw)
	if err != nil {
		t.Fatalf("ParseContract: %v", err)
	}
	if len(c.Stages) != 2 {
		t.Fatalf("stages: %+v", c.Stages)
	}
	if c.Stages[0].Name != "clarify" || c.Stages[0].Description != "澄清拍板问题" {
		t.Fatalf("object-form stage: %+v", c.Stages[0])
	}
	if c.Stages[1].Name != "execute" || c.Stages[1].Description != "" {
		t.Fatalf("string-form stage: %+v", c.Stages[1])
	}
}

func TestParseContractStageUnknownField(t *testing.T) {
	raw := json.RawMessage(`{
		"stages": [{"name": "s", "descriptoin": "typo"}],
		"gates": [{"name": "g", "after_stage": "s"}],
		"budget": {"max_tokens": 100}
	}`)
	if _, err := ParseContract(raw); err == nil {
		t.Fatal("expected error for unknown stage field")
	}
}
