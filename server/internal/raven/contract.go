package raven

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

// Contract is the mandatory static declaration every workflow carries
// (ADR-0005): what stages it runs, where it stops for humans, and what it
// may spend. Authors cannot register a workflow without one.
type Contract struct {
	Stages []ContractStage `json:"stages"`
	Gates  []ContractGate  `json:"gates"`
	Budget ContractBudget  `json:"budget"`
	// Permissions is free-form in v1 (harness-level enforcement comes later);
	// kept in the schema so contracts declare intent from day one.
	Permissions map[string]any `json:"permissions,omitempty"`
}

type ContractStage struct {
	Name string `json:"name"`
	// Description is optional author documentation.
	Description string `json:"description,omitempty"`
}

type ContractGate struct {
	Name string `json:"name"`
	// AfterStage names the stage this gate suspends after. Must reference a
	// declared stage.
	AfterStage string `json:"after_stage"`
}

type ContractBudget struct {
	// MaxTokens caps total model tokens per run; 0 = not set.
	MaxTokens int64 `json:"max_tokens,omitempty"`
	// MaxUSD caps total spend per run; 0 = not set.
	MaxUSD float64 `json:"max_usd,omitempty"`
}

// ParseContract validates the mandatory contract fields: at least one named
// stage, at least one gate referencing a declared stage, and a budget with
// at least one positive limit. Returns the parsed contract or a
// caller-displayable error.
func ParseContract(raw json.RawMessage) (Contract, error) {
	var c Contract
	dec := json.NewDecoder(bytesReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return Contract{}, fmt.Errorf("contract is not valid JSON or has unknown fields: %w", err)
	}

	if len(c.Stages) == 0 {
		return Contract{}, errors.New("contract.stages must declare at least one stage")
	}
	stageNames := make(map[string]bool, len(c.Stages))
	for i, s := range c.Stages {
		if s.Name == "" {
			return Contract{}, fmt.Errorf("contract.stages[%d].name is required", i)
		}
		if stageNames[s.Name] {
			return Contract{}, fmt.Errorf("contract.stages has duplicate name %q", s.Name)
		}
		stageNames[s.Name] = true
	}

	if len(c.Gates) == 0 {
		return Contract{}, errors.New("contract.gates must declare at least one gate — ungated workflows are not registrable")
	}
	for i, g := range c.Gates {
		if g.Name == "" {
			return Contract{}, fmt.Errorf("contract.gates[%d].name is required", i)
		}
		if !stageNames[g.AfterStage] {
			return Contract{}, fmt.Errorf("contract.gates[%d].after_stage %q does not reference a declared stage", i, g.AfterStage)
		}
	}

	if c.Budget.MaxTokens <= 0 && c.Budget.MaxUSD <= 0 {
		return Contract{}, errors.New("contract.budget must set max_tokens or max_usd")
	}

	return c, nil
}
