# Issue #1: upstream API probes

These small probes validate **integration points**, not the planned workflow product.

The dependency versions in the root `package.json` are explicitly pinned to the Pi `1.3.0` release, verified against released [v1.3.0 (71023ae)](https://github.com/earendil-works/pi/tree/71023aec1546d6d677a65669c5665c0927ce0dd0); newer [main (482c138)](https://github.com/earendil-works/pi/tree/482c1381a00d8d00bc81697e4a980c593db6803e) was audited separately.

```sh
# Node >=22.19 (required by upstream); no API keys needed for durable test
npm install
npm run typecheck
npm run smoke:durable

# In a normal Pi coding-agent process, with the same package dependencies:
pi --extension ./spikes/issue-1/regular-pi.ts
# Then use /spike-workflow hello or ask the agent to call spike_workflow.
```

The command and tool intentionally echo the **same deterministic handler**, proving the two registration surfaces; they do not auto-discover workflows or execute user-supplied code.

The durable probe registers actual `defineTask` implementations and starts a conversation-owned parent task that atomically creates two child tasks and commits a `waiting` checkpoint. The children use the released invocation-bound `runtime.sleep()` with an absolute deadline persisted via `runtime.memo()` (not a persisted sleeping-task checkpoint). The harness closes while the parent waits, then reopens the same database; child phases may be reattempted but reuse the original memoized deadline, and the parent completes via `runtime.outcomes()`. Newer upstream main adds a durable `sleepUntil()` method unavailable in 1.3.0.

This is a **controlled shutdown/reopen** and replay demonstration, not a test of persisted timer scheduling. A real process-kill, idempotency/side-effect injection and Cloudflare Durable Object eviction test belong in [issue #3](https://github.com/mhingston/pi-workflows/issues/3). All side effects here are limited to creating and removing a temporary SQLite database.

`npm run typecheck` checks both entry points, but does not execute Pi CLI interaction; verify the command/tool manually or with an upstream Pi harness integration test later. No actual model calls are made.

See [docs/feasibility.md](../../docs/feasibility.md) for the supported/unsupported/unknown matrix and decision.
