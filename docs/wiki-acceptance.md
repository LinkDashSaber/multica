# Wiki synchronization acceptance

This document describes the dedicated test repository used to verify Raven Wiki updates.

## Baseline behavior

The acceptance document export format is Markdown. The retention period for these test exports is 14 days. The fixture scenario identifier is MULTICA-WIKI-ACCEPTANCE-20261103.

## Verification boundary

Tests run against a local Raven Development backend. They do not deploy Multica or operate a production database. New commits on the dedicated tracked branch should update the cloud Wiki without replacing an existing local reading snapshot. A user explicitly synchronizes to load the new version.
