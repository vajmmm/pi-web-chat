# Context / Memory / Compaction v1.1

The harness separates durable facts from the model's bounded request-time view.

## Authority boundaries

- `server/runtime-artifacts.ts` owns raw execution evidence outside Git worktrees.
- `PromptAssembler` emits a cross-task global prefix and a task-lifetime-stable suffix.
- Pi native compaction is the only compaction authority; its summary is a continuation hint.
- `CompactionEvidenceIndex` is a latest-only deterministic navigation view.
- `TaskEpisodeCard` is an immutable terminal projection and reuses existing task and verification statuses.
- Coordinator task queries consume bounded Episode views, not Subagent transcripts or evidence indexes.

Working Memory, Process Journal, their tools, and the harness LLM compactor have been removed. The
`legacy-task-memory-cleanup.ts` module exists only to delete directories made by earlier versions.

## Execution and projection sequence

```text
tool executes
  -> earliest complete output becomes available
  -> copy Pi full-output file or persist tool result in Fact Store
  -> register artifacts:// identity and runtime path
  -> construct role-bounded head/tail preview
  -> append preview (and pointer when virtualized) to Pi conversation
  -> send request-time model view
```

If Pi reports a truncated result without a readable full-output file, the artifact is explicitly
marked `preview_only`; it is never presented as complete raw evidence.

## Runtime layout

By default, artifacts live under the Pi agent directory. `HARNESS_RUNTIME_ROOT` can override the
root for deployment or tests.

Preview budgets are configurable with `HARNESS_COORDINATOR_OUTPUT_BUDGET_BYTES`,
`HARNESS_SUBAGENT_OUTPUT_BUDGET_BYTES`, and `HARNESS_VERIFIER_OUTPUT_BUDGET_BYTES`.

```text
harness-runtime/
  runs/<runId>/tasks/<taskId>/
    transcript.jsonl
    tool-executions.jsonl
    task-result.json
    episode.json
    verifier.json
    tool_outputs/
```

Episode cards persist only `artifacts://` references. Absolute runtime paths are included only in
live tool previews and request-time Episode/Evidence views so the executing agent can use `read`
on a resolved path even after the original tool message has been compacted. Paths are resolved
from the current runtime root; escaping references and symlinks are rejected.

Pi shell failures can omit final-result metadata. The execution-update hook retains the full-output
metadata by tool-call ID until the result is persisted. It never trusts a path found only in tool
output text. Missing full-output metadata is conservatively marked `preview_only`. Large previews
read bounded file head/tail windows and retain command failure status.

## Compaction hooks

`session_before_compact` captures Pi's exact boundary, file operations, and compacted tool-call IDs,
including `turnPrefixMessages` when Pi splits a turn.
After `session_compact`, the harness recomputes one index from durable facts. The `context` hook
projects that index without mutating `agent.state.messages`. A later compaction replaces the index.
The 8 KiB cap includes the final rendered text and wrapper. Lineage has a 6 KiB aggregate cap
including the serialized authority wrappers. Transcript IDs come from persisted Pi entries,
flushed on message/turn/agent boundaries, since `message_end` occurs before Pi appends the entry.

Episode generation freezes the episode and referenced result together. Later queries load the
frozen episode instead of rewriting its source artifacts. Worktree cleanup retains evidence;
explicit task/session deletion removes it after quiescence. Cleanup failure retains task metadata
and the existing deletion tombstone so the operation can be retried.

## Cache and telemetry

The global and task prefix blocks each have deterministic SHA-256 hashes. Turn recording also
extracts `requestPrefixHash` from provider instruction blocks (including developer roles), tools,
and tool-choice configuration. This fingerprint measures those fields' stability, not actual cache
hits or the entire provider cache key. Tool artifact records contain raw byte count, completeness,
failure status, and pointers.

Stall handling is observational. Repeated identical command outcomes can emit a warning, but the
harness does not abort. Fingerprints include the observed result, successful edits reset repetition,
and unchanged repeats are warning-deduplicated. Repeated failing verification commands and inverse
edits have separate counters. These are heuristic signals, not proof of task failure. Compaction
count/context pressure is telemetry only and cannot independently trigger a stall warning.

Real-provider 50+/100+ tool-turn evaluation and cache-usage calibration remain separate validation
work; local integration tests do not establish those outcomes.
