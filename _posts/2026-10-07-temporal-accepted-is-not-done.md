---
title: "Accepted is not done: how a fan-out of 200,000 workflows made our Temporal cluster look frozen"
description: "How starting one Temporal workflow per item made our cluster look frozen, why batching starts is not backpressure, and how a sliding window on handle.result() fixed it."
tags: [temporal, typescript, postgresql, backpressure, scalability]
series: "Temporal in production"
series_part: 2
image: /assets/images/og-temporal-accepted-is-not-done.png
---

This is the second post in my Temporal series. The first one was about a contract that silently broke at a language boundary. This one is about scale: how a perfectly reasonable fan-out, one workflow per item, made our self-hosted Temporal cluster look frozen for hours, and how changing what we wait for fixed it.

The short version: **a started workflow is not a finished one.** Our importer waited for the first and ignored the second.

As before, the domain is anonymized, and it's snacks again. Instead of the real data, we import a tasting archive: a large export from a snack-tasting app, where each tasting note can carry attachments such as photos and scanned wrappers. The code is simplified, but the shape of the problem and the numbers are real. The names are not.

## Act I: one workflow per tasting note

The design was simple, and for small archives it worked. An import activity reads the archive and starts a `tastingNoteWorkflow` for every note. If a note has attachments, the note workflow starts a child workflow per attachment: one workflow type for photos, another for wrapper scans.

Each workflow type has its own task queue and its own workers. Some activities are shared, though. `tagFlavors`, for example, is called both from note workflows and from photo workflows, and all of its executions run on one dedicated activity task queue.

Everybody knew that one workflow per note was not the most efficient design. It was the easiest one, and while the archives were small, nobody felt the cost.

The importer looked roughly like this (simplified):

```ts
const BATCH_SIZE = 200;

export async function importTastingArchiveActivity({ archiveId, archiveUrl }: Args) {
  const resumeFrom = parseHeartbeat(activityInfo().heartbeatDetails)?.batchIndex ?? 0;
  const notes = await readWholeArchive(archiveUrl); // everything in memory
  using client = await getWorkflowClient();

  let batchIndex = resumeFrom;
  for (const batch of chunk(notes, BATCH_SIZE).slice(resumeFrom)) {
    heartbeat({ batchIndex });
    await Promise.all(
      batch.map((note) =>
        client.workflow.start(tastingNoteWorkflow, {
          workflowId: `tasting-note-${note.id}`,
          taskQueue: TASK_QUEUES.TASTING_NOTES,
          searchAttributes: { ArchiveId: [archiveId] },
          args: [{ note }],
          workflowIdConflictPolicy: "USE_EXISTING",
        }),
      ),
    );
    batchIndex++;
  }
}
```

Look at what the loop waits for. `client.workflow.start` resolves when the Temporal frontend has **accepted** the start request: the workflow exists and its first workflow task is scheduled. Nothing has run yet.

So the batching doesn't throttle the system. Send 200 starts, wait for 200 acknowledgements, send the next 200. The whole archive is handed to Temporal as fast as the server can say "OK".

## Act II: the freeze

Then the archives got big. The largest one I processed had around 200,000 tasting notes, many of them with attachments. I have seen an export with over 400,000, but I never ran anything that large through this pipeline.

What we saw:

- Temporal UI showed an enormous number of running workflows, and almost none of them made progress.
- Some workflows waited hours for their **first workflow task**. Not an activity: the very first step of the workflow code.
- The PostgreSQL database behind Temporal (where workflow histories live), with 5 CPUs in Kubernetes, sat at its CPU limit.
- Processing a single archive took up to about 15 hours.

Watching it live was strange. A batch of 200 workflows appeared in Temporal UI, and some of them started making progress. A fraction of a second later came the next 200, and a smaller share of those got going. Then the next 200, with an even smaller share. And so on. Things began to unclog, slowly, only once the importer stopped scheduling new workflows.

From the outside it looked like Temporal had frozen. It hadn't. It was doing exactly what we had asked it to do.

## Act III: firefighting with `synchronous_commit`

The database was the visible bottleneck, so I went there first. Temporal persistence runs a lot of small transactions. By default, PostgreSQL waits for each commit's WAL record to be flushed to disk before acknowledging it. Setting `synchronous_commit = off` removes that wait, and it helped a little.

It is a trade-off, not a fix. With asynchronous commit, a database crash can lose the last fraction of a second of transactions that were already reported as committed. The database stays consistent, it just forgets the most recent writes. For Temporal, that means the server may have acknowledged a state change (a started workflow, a completed task) that is gone after recovery. We accepted that risk consciously. I wouldn't recommend it as a default.

More importantly, a faster database treats the symptom. The cause was in our code.

## Act IV: accepted is not done

Here is my best explanation of what happened. It fits everything we observed, but I didn't have the server metrics to prove every step, so treat it as a model rather than a post-mortem.

**Every start costs the database work.** Accepting a start means persisting the execution, its first history events and a task that hands the first workflow task over to matching. Our importer produced these writes as fast as the server would accept them, so the database was busy mostly with new starts.

**Workflow tasks pile up.** Kubernetes scaled the note workers out to eight instances, and they still couldn't keep up, so a backlog built up. The first workflow tasks of hundreds of thousands of new workflows filled the queue, adding latency for every workflow that had already been started. For comparison, the bounded version described below ran comfortably on two workers.

**The real work has to queue too.** When an early note workflow finally ran, it called `tagFlavors` and started child workflows for its attachments. Separate task queues per workflow type helped a little: a photo workflow didn't wait behind the first tasks of note workflows. The shared activity queue didn't help at all. A `tagFlavors` call from a photo workflow had to compete with the `tagFlavors` calls of nearly every note in the archive.

The cluster itself was configured in a standard way (512 history shards, the default in the Helm chart version we used), so the problem wasn't in Temporal's configuration.

## Act V: wait for the result, not the acceptance

The fix changed one thing: what the importer waits for. Instead of starting everything, it keeps a **sliding window** of N notes in flight and starts the next one only when one of them **finishes**. Finishing is what `handle.result()` reports, and for a note it covers the whole thing, including the child workflows of its attachments, because a note workflow waits for its children before it completes.

The window itself is a few lines:

```ts
function createWindow(size: number) {
  const inFlight = new Set<Promise<void>>();
  let failures = 0;

  return {
    async acquire() {
      while (inFlight.size >= size) {
        await Promise.race(inFlight);
      }
    },
    track(handle: WorkflowHandle) {
      const done = handle.result().then(
        () => undefined,
        () => { failures++; },
      );
      inFlight.add(done);
      void done.finally(() => inFlight.delete(done));
    },
    drain: () => Promise.allSettled(inFlight),
    failures: () => failures,
  };
}
```

And the loop:

```ts
const slots = createWindow(WINDOW_SIZE);

for (let i = startFrom; i < notes.length; i++) {
  if (signal.aborted) throw new CancelledFailure("import cancelled");

  await slots.acquire(); // wait for a free slot first...
  const handle = await client.workflow.start(tastingNoteWorkflow, { /* as before */ }); // ...then start
  slots.track(handle);

  lastStartedIndex = i;
  heartbeat({ lastStartedIndex });
}

await slots.drain();
log.info("import finished", { failedNotes: slots.failures() });
```

There is also a timer that heartbeats every 5 minutes, because with a full window the loop can sit in `acquire()` for a long time.

Notes that fail are logged and counted, but they don't fail the import. Each note has its own workflow history and can be retried on its own.

The result: the freeze disappeared immediately, and a similar archive was processed in about 7 hours instead of about 15.

And that was with `synchronous_commit` back on. For the bounded version we restored the default, so the database was back to full durability, and the improvement came from the code change alone.

### How big should the window be?

I started with a window of 50, a number I pulled out of a hat. It turned out to be too small, because many note workflows finish in a few seconds.

Why so fast? Tasting notes vary wildly. One note is just "Yum!", another is a detailed review with ingredients and a photo of the wrapper. In our pipeline, `tagFlavors` feeds two follow-up activities that run in parallel. For a note like "Yum!" it finds nothing to tag, so the workflow skips both follow-ups and ends almost immediately, freeing its slot in the window within seconds.

Little's law shows how much the window size matters:

```
throughput = items in flight / average time in flight
```

We doubled it to 100.

Read backwards, the numbers hang together. 200,000 notes in about 7 hours is roughly 8 notes per second. With 100 in flight, that means about 12 seconds per note on average, attachments included. As a rough upper-bound estimate, assuming the same average time in flight, a window of 50 would have taken around 14 hours, about as long as the unbounded version. In practice it would probably have been somewhat less, because a smaller window also means less load and shorter waits.

I also ran short experiments with windows of 120, 150 and 200, and none of them looked bad. 150 looked especially good when the workflows were very short, because many notes took the early exit described above. Short workflows put little load on the rest of the system, so more of them can be in flight before anything downstream saturates. Overall, 100 and 150 gave very similar results. The best value depends on the data anyway, so we stayed with the more conservative 100.

The catch is that time in flight isn't constant. Make the window large enough and the workers, the shared activity queues and the database saturate, each note takes longer, and you drift back towards the freeze. The right size depends on what sits downstream. That's why we made it an environment variable.

## Dark corners

The window fixed the freeze. But an activity that orchestrates hundreds of thousands of workflows for hours has a few corners worth knowing about.

### Rebuilding the window after a retry

Our heartbeat stored only the index of the last started note. After a retry (a deploy, a crashed pod), the activity rebuilt the window as "the last N indices" and re-attached to those workflows.

That assumes the window always holds consecutive indices. It doesn't. Take a window of 3. Note 0 is slow, while notes 1, 2, 3 and onwards finish quickly. By index 10 the window holds {0, 9, 10}. Rebuilt as [8, 9, 10], note 0 drops off the books:

- the importer thinks it has a free slot, so for a while more than N notes run;
- nobody waits for note 0, so `drain()` can return, and the import can report success, while note 0 is still running. If it fails, nobody counts it.

Nothing is lost, note 0 finishes on its own. We just stop watching it.

Storing the IDs of the in-flight workflows in the heartbeat fixes this, but with a window of 100 it felt clumsy. The alternative, which we never got around to implementing, is to ask Temporal. Every note workflow carries a search attribute with the archive ID, so on resume:

```ts
const running = client.workflow.list({
  query: `ArchiveId = "${archiveId}" AND WorkflowType = "tastingNoteWorkflow" AND ExecutionStatus = "Running"`,
});
for await (const wf of running) {
  slots.track(client.workflow.getHandle(wf.workflowId));
}
// then continue the main loop from lastStartedIndex + 1
```

The query doesn't care about indices. It returns 0, 9 and 10 because those are the ones still running. The heartbeat stays tiny, and if more than N are running after a crash, the main loop's `acquire()` simply waits until enough of them finish.

Visibility is eventually consistent, so the query can be off in two ways. A workflow that has just finished but still shows as running is harmless: its result resolves immediately. A workflow started just before the crash may not be indexed yet. One way to make that safe enough in practice would be to also re-attach the last few indices.

One more thing about the resume index itself. `activityInfo().heartbeatDetails` returns the last heartbeat that reached the server, not the last one the code called. The SDK throttles heartbeats, so when a pod dies, the most recent details may never be sent. The resumed index can lag behind real progress, and a few notes get started again. Running ones are simply re-attached thanks to `USE_EXISTING`, and finished ones run once more. Note processing is idempotent, so this costs some extra work, not wrong data.

### Timeouts are part of correctness

The importer now lives as long as the whole import. Our options:

```ts
proxyActivities<typeof importActivities>({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "20 minutes",
  retry: { initialInterval: "1 second", maximumAttempts: 3 },
});
```

- `heartbeatTimeout` is what detects a dead worker. Without it, a crashed pod would be noticed only when the 24-hour `startToCloseTimeout` runs out. Twenty minutes is a comfortable margin over the 5-minute heartbeat timer.
- Every deploy during an import costs an attempt: the running attempt dies with the pod and the activity is retried. With `maximumAttempts: 3`, three deploys during one long import fail it, even though nothing was wrong with the data.
- Every retry repeats the preparation: reading the whole archive into memory and preparing documents, before resuming from the heartbeat. In practice even a large archive loaded quickly, so it never caused trouble. It's still worth watching: if that phase ever ran longer than the heartbeat timeout without heartbeating, every attempt would die in the same place.

## Why an activity and not a workflow?

Experienced Temporal users will ask why the window lives in an activity. The idiomatic alternative is a parent workflow that starts note workflows as children, keeps N of them running and calls continue-as-new from time to time to keep its history small.

That version survives worker restarts for free. It moves the window state from volatile process memory into Temporal's durable state, so there is no heartbeat bookkeeping, no rebuilding after a retry and no 24-hour activity to babysit.

We kept the activity because it was the smallest change to code that already worked, and even that took some convincing. The price is everything in the previous section: the state of the window lives in memory, and correctness after a retry depends on how carefully you rebuild it. If I were designing this again, I'd seriously consider the workflow version.

## Takeaways

1. **A started workflow is not a finished one.** `start()` only tells you Temporal has accepted the work, so batching starts throttles the client, not the system. If you want to control load, wait for `result()`.
2. **New starts compete with the workflows already running.** Throughput is capped anyway, but every new start adds work to the same system that is trying to finish the workflows already in flight. From the outside, that looks like a freeze.
3. **A shared activity queue limits what separate workers can do.** Work from every workflow type still meets on the shared queue.
4. **Size the window with Little's law, then watch downstream.** Too small and you're slow, too large and you're back to the freeze.
5. **Database tuning is a trade-off, not a fix.** `synchronous_commit = off` helped a little, but it trades durability for speed and doesn't touch the cause. Once the code was fixed, we turned it back on.
6. **A long-running orchestrating activity makes timeouts and heartbeats part of correctness.** They decide how fast a dead worker is noticed, how many deploys an import survives and where it resumes.

## How it ended

With the window in place, imports stopped looking frozen and finished in about half the time.

Some things we didn't change. The importer still reads the whole archive into memory. Each note workflow still receives the full note as its argument, so the data ends up in its history; passing an ID and loading the note in an activity would be lighter. And one workflow per note stayed. Moving away from it would have been a business decision, and not one I was in a position to make.

The practical lesson: when you hand work to Temporal, decide up front how much of it may be in flight at once.