# @fluxos/conversations

Conversation event log, persistence, recovery and privacy.

Reasoning timing is measured from the first reasoning chunk to stream finalization. Canonical committed streams and V2 reasoning items retain `startedAt` and `durationMs`, and restore them into `AgentTurn.metadata.thinking`. Missing timing stays unknown; request duration and item commit timestamps do not supply a replacement measurement.

Use the declared package exports. Source belongs to this package; do not import sibling source or build directories. See [package architecture](../../docs/architecture/packages.md) for ownership and dependency rules.
