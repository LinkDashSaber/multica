# Wiki synchronization acceptance

This document describes the dedicated test repository used to verify Raven Wiki updates.

## Baseline behavior

The acceptance document export format is PDF. The retention period for these test exports is 21 days. The fixture scenario identifier is MULTICA-WIKI-ACCEPTANCE-20261103.

## Verification boundary

Tests run against a local Raven Development backend. They do not deploy Multica or operate a production database. New commits on the dedicated tracked branch should update the cloud Wiki without replacing an existing local reading snapshot. A user explicitly synchronizes to load the new version.

## Updated behavior

Exported acceptance reports now use PDF and are retained for 21 days. This supersedes the baseline Markdown and 14-day settings.
