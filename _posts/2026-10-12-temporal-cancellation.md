---
title: "Cancel is a request, not a command: what Temporal cancellation actually did to our workflows"
description: "Why cancelled Temporal workflows left our database untouched, why some cancels were instant and others took much longer, and why a cancelled workflow could still end COMPLETED."
tags: [temporal, typescript, cancellation, heartbeats, activities]
series: "Temporal in production"
series_part: 4
image: /assets/images/og-temporal-cancellation.png
---

This is the fourth post in my Temporal series. The previous one was about how an activity spends its time. This one is about what happens when you try to stop one: **cancellation.**

The short version: **a cancel is a request, not a command.** It reaches an activity only through a heartbeat, it only stops the activity if the activity acts on it, and nothing in the workflow turns it into a status unless you do.

As before, the domain is anonymized, and it's snacks again. Our app processes tasting notes with a workflow per note, and we wanted to see in our own database what happened to each one. The code is simplified. You can run all of the experiments yourself, no Docker needed: [temporal-cancel-playground](https://github.com/jmilkiewicz/temporal-cancel-playground) (TypeScript SDK 1.24.0, a real local dev server, no mocks).

## The setup

We wanted visibility. Every activity run inside a workflow, and the workflow itself, got a status and some metadata in our own storage, so support could see what happened without opening Temporal UI.

Cancellation was where that picture fell apart. It behaved differently depending on which activity was running, whether it heartbeated, and which line of the workflow we were on.

All cases below use the default `cancellationType`, `WAIT_CANCELLATION_COMPLETED`. The workflow is cancelled with a plain `handle.cancel()` while an activity is running. The playground has three kinds of activity, all calling a slow local HTTP endpoint:

- **`slow`:** never heartbeats.
- **`heartBeatingHonouringCancel`:** heartbeats and passes `cancellationSignal()` to `fetch`.
- **`heartBeatingWithIgnoringCancelSignal`:** heartbeats, notices the cancel and carries on anyway.

## Act I: the dashboard that lied

Someone cancelled a workflow, and our storage said nothing had happened. We found it from the logs: there was a cancellation exception in the worker logs, but the note's record in our database hadn't changed. The workflow had been cancelled, and our storage had no idea.

When a workflow is cancelled, the `await` it is sitting on throws a `CancelledFailure`, which passes `isCancellation`. In our `catch` we tried to call an activity to mark the note as cancelled. That call failed immediately, because the workflow code was still in a cancelled scope and Temporal refuses to start new cancellable operations there.

The playground shows this in `cancelWorkflowCleanupUnprotected`: `cleanup()` is called in the cancelled scope, and its counter stays at 0.

The fix is one wrapper:

```ts
await CancellationScope.nonCancellable(async () => {
  try {
    await markTastingNoteCancelled(tastingNoteId);
    log.info("marked as cancelled", { tastingNoteId });
  } catch (markError) {
    log.error("failed to mark as cancelled", {
      error: markError,
      tastingNoteId,
    });
  }
});
```

Inside `nonCancellable` the activity runs. After it, we rethrow the original cancellation, so the workflow still ends CANCELLED. That is `cancelWorkflowCleanupThenRethrow`: cleanup ran once, status CANCELLED.

## Act II: cancel that took 5 seconds, or much longer

Next came timing. Sometimes a cancel took effect almost instantly, sometimes the workflow hung around long after we asked.

With `WAIT_CANCELLATION_COMPLETED`, the workflow does not consider the activity cancelled until the activity reports back. So the cancel time is the activity's problem.

An activity only learns about a cancel through a heartbeat: the server's heartbeat response carries the cancel request, and that aborts `cancellationSignal()` inside the activity. That gives three kinds of activity:

| Activity | After cancel, the workflow waits... |
|---|---|
| Never heartbeats (`slow`) | Until it finishes, however long that takes (about 5s in the playground). It never learns about the cancel. |
| Heartbeats and honours the signal | Until the next heartbeat that is actually sent: about 230ms in the playground (see the note on throttling below). |
| Heartbeats, but ignores the signal | Until it finishes. The activity knew about the cancel and carried on. |

"Honours the signal" means checking `cancellationSignal().aborted` or passing the signal to the underlying call:

```ts
const response = await fetch(url, { signal: cancellationSignal() });
```

**Heartbeats are throttled.** Calling `heartbeat()` doesn't always send anything to the server. The worker sends the first heartbeat at once, then holds back later ones and sends only the most recent when a timer fires. The timer is `heartbeatTimeout * 0.8` if you set a heartbeat timeout, otherwise 30 seconds by default, and never more than 60 seconds. The cancel only reaches the activity in the response to a heartbeat that was actually sent, so a cancel can arrive up to a throttle interval late. If you don't set `heartbeatTimeout`, heartbeating more often won't make cancels faster.

**The playground numbers are best case.** The 230ms is the first heartbeat, which is sent immediately, and the playground sets a 2s heartbeat timeout (a 1.6s throttle). Don't read the 5s and 230ms as typical for production.

Short activities don't need heartbeats, because they finish before anyone notices. The long ones are different. Some of ours parse very large files, and others call an API in a loop. Both can run for a long time, and both benefit from heartbeats and from acting on them: heartbeating lets the cancel reach the activity, and checking the signal lets the activity stop. Without both, a cancel meant waiting for the whole file or the whole loop to finish.

This echoes the previous post. There, a translation that had already timed out still ran in full, because nothing told the worker to stop. A cancel that never reaches an activity, or that the activity ignores, leaves you in a similar place: the work carries on, and nobody is waiting for it.

## Act III: cancelled, but COMPLETED

The strangest case: we cancelled a workflow while its last activity was running, and the workflow ended **COMPLETED** instead of CANCELLED.

The confusing part was that it was the same workflow every time. Sometimes we clicked cancel and it ended up CANCELLED. Other times, especially when it looked stuck, we clicked cancel and nothing seemed to happen. The workflow kept running, and at some point it finished as COMPLETED.

"Nothing happens" and "COMPLETED" were one story: the cancel request had been delivered to the workflow, but the activity it was waiting on didn't act on it, and nothing in the workflow code turned the request into a status.

Cancellation is cooperative at the workflow level too. The `CancelledFailure` only surfaces at the next cancellable `await`. If the activity finishes normally and nothing in the workflow awaits afterwards, the workflow just returns.

The playground has the two cases side by side, with the same activity and the same cancel:

- **A step follows the activity** (`callTwice`): the second activity is never scheduled, and the workflow ends CANCELLED.
- **The activity is the last step** (`cancelWholeWorkflow`): the workflow returns `completed: ... cancelled=true`, and it ends COMPLETED.

So how a workflow ends depends on which line it was on when the cancel arrived.

**Our fix: force CANCELLED.** The activity did finish, but the user asked for a cancel, and we wanted Temporal's status to match what we showed in our own storage. After the last activity we check whether the cancel was requested, and if it was, we throw:

```ts
export async function tastingNoteWorkflow(input: Input): Promise<string> {
  const result = await publishTastingNote(input);

  if (CancellationScope.current().consideredCancelled) {
    throw new CancelledFailure(`cancelled after activity returned: ${result}`);
  }
  return `completed: ${result}`;
}
```

`consideredCancelled` is true when the scope was cancelled, directly or through a cancellable parent. The playground test `cancelWorkflowCheckAfterLastActivity` shows the result: the activity runs to the end, and the workflow ends CANCELLED.

Two details:

- **Where to check it:** `consideredCancelled` is always false inside `CancellationScope.nonCancellable(...)`, so check it in the workflow's main scope, not inside your cleanup block.
- **Only throw after a real cancel:** the SDK turns a thrown `CancelledFailure` into CANCELLED only if the workflow itself was cancelled (`handleWorkflowFailure` in `@temporalio/workflow`). Otherwise, including when only an inner scope was cancelled, the workflow ends FAILED.

**This is a choice, not the only answer.** The work did complete. Reporting it as CANCELLED is the right call when you want the status to reflect the user's intent. If you'd rather report the truth about the work, return COMPLETED and record "cancel was requested" as metadata. Either way, decide on purpose instead of letting the last `await` decide for you.

## A note on the other cancellation types

We stayed on the default, but `TRY_CANCEL` and `ABANDON` are worth knowing: the workflow is CANCELLED within a second, while the activity keeps running. In the playground, `slow` ran for the full 5s after the workflow had closed, and Temporal's core logged `Activity not found on completion... workflow execution already completed` when it finished. You get a fast cancel and orphaned work to handle.

The repo also has an earlier variant, where a signal cancels an inner `CancellationScope` and the workflow carries on. The rules are the same.

## Takeaways

1. **A cancelled workflow isn't a finished one.** It can end CANCELLED while the work goes on (`TRY_CANCEL`, `ABANDON`), or COMPLETED even though a cancel was requested.
2. **Cancel handlers run in a cancelled scope.** Anything you schedule after catching `isCancellation` needs `CancellationScope.nonCancellable`, and you still have to rethrow if you want CANCELLED.
3. **A heartbeat delivers the cancel. It doesn't act on it.** The activity has to check `cancellationSignal()` or pass it to its I/O.
4. **An activity without heartbeats can't hear a cancel until it finishes.** With the default type, the workflow waits for it. Heartbeats are throttled, so even a heartbeating activity can hear it late.
5. **How a cancelled workflow ends depends on the next `await`.** After the last activity, check `consideredCancelled` and decide what the status should be.

## How it ended

We went through all of our longer activities and gave them both halves: they now heartbeat, and they act on the cancel.

Acting on it was sometimes trivial. When the API you call accepts a signal, like `fetch`, you pass `cancellationSignal()` and you're done. Often it isn't. The clients we use for Kafka and for the database don't take a signal as input, so the activity has to check `cancellationSignal()` itself and stop at a point where stopping is safe.

Together with the `nonCancellable` marker from Act I and the final-status check from Act III, a cancelled workflow now ends CANCELLED, and our storage says the same.

The practical lesson: **cancellation is a conversation between the workflow and the activity, and both sides have to take part.** The workflow decides what to wait for and what to report, and the activity decides whether it ever hears the request and whether it acts on it.
