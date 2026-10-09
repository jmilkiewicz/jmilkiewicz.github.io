---
title: "Same signature, different beast: what happened when our Temporal activity stopped being pure I/O"
description: "How swapping an LLM translation call for a local model turned each Temporal worker into a one-lane road, why it showed up as heartbeat timeouts, and why 60 replicas made it worse."
tags: [temporal, python, asyncio, kubernetes, keda, performance]
series: "Temporal in production"
series_part: 3
image: /assets/images/og-temporal-execution-profile.png
---

This is the third post in my Temporal series. The first was about a data contract that silently broke at a language boundary. The second was about load: a fan-out that made our cluster look frozen. This one is about something I hadn't thought of as part of a contract at all: **how an activity spends its time.**

The short version: **one pod, one event loop, one translation at a time.** We replaced a network call with a blocking, CPU-bound model call inside an `async def` activity. From then on, each Python worker could run only one translation at a time, no matter how many it had accepted, and the translations waiting their turn couldn't even tell Temporal they were alive.

As before, the domain is anonymized, and it's snacks again. Our app collects tasting notes from all over the world, and to show them in one feed, we translate them. The code is simplified. The settings and timeouts are the real ones.

## Act I: two branches that look the same

Translation could go one of two ways, depending on how a client was configured:

```ts
if (translationParameters.kind === "languageModel") {
  // TypeScript activity: a direct call to an LLM
  return translateTastingNoteText({
    tastingNote: { text },
    outputLanguages: translationParameters.outputLanguages,
    model: translationParameters.languageModel,
  });
} else {
  // Python activity: our own translation model
  return translateWithOwnModel({
    text,
    outputLanguages: translationParameters.outputLanguages,
    ...(translationParameters.selectedTranslationModel && {
      selectedTranslationModel: translationParameters.selectedTranslationModel,
    }),
  });
}
```

Read it as the workflow sees it: same inputs, same output, two interchangeable implementations. Nothing here tells you that the first branch is an HTTPS request and the second one, most of the time, is a matrix multiplication.

The TypeScript branch was boring in the best way. The activity sent a request to an LLM and awaited the response. While it waited, the Node.js event loop was free to run other activities. In Grafana, activity execution time was low and so was schedule-to-start latency. The worker spent most of its life waiting on sockets.

At our scale, though, paying per token added up. So the company decided to translate with its own model, served by a new Python worker (one per Kubernetes pod) on a new task queue. Clients were moved to it gradually, which is why, for a while, only some of them were affected.

## Act II: one pod, one lane

The Python activity did more than the TypeScript one. It detected the source language with fastText, translated locally with a Marian model if the language pair was supported, and otherwise fell back to an LLM over HTTPS. While it worked, a keepalive sent a heartbeat every 3 seconds. Simplified:

```python
@activity.defn
async def translate_text(self, args: dict[str, Any]) -> dict[str, Any]:
    stop_heartbeat = self._start_heartbeat_keepalive()  # heartbeat every 3 s
    try:
        source = self.factory.identify_language(args["text"])  # CPU
        result = self.factory.translate(                         # CPU, or blocking HTTP
            args["text"], source, args["target_language"]
        )
    finally:
        stop_heartbeat()
    return {"output_text": result}
```

And the worker setting that mattered:

```python
temporal_max_concurrent_activities = 50
```

The `async def` decides everything here. In the Temporal Python SDK, an `async def` activity runs on the worker's asyncio event loop. A plain `def` activity runs on a thread pool, which you have to give the worker explicitly. The SDK README is explicit about which to prefer: threaded activities are the initial recommendation, and there is a boxed warning not to block the thread in an `async def` function.

The configuration also had `temporal_activity_max_threads = 10`, which suggests someone expected threads to be involved. With only `async def` activities, they weren't: no thread pool ran any of this code, and the setting had no effect.

Look at the body again: there isn't a single `await` in it. Language detection, local inference and even the LLM fallback were ordinary blocking calls. An `async def` with no `await` doesn't give the event loop back until it returns.

So while one translation was running, every other translation on that pod simply stood still. The worker accepted up to 50 of them and ran them strictly one after another. **A pod configured for 50 concurrent activities behaved like a pod configured for one.**

## Act III: timeouts on a three-minute activity

That alone would have made translations slow. What made them fail was this, on the workflow side:

```ts
proxyActivities<TranslationPythonActivities>({
  taskQueue: TASK_QUEUES.TRANSLATION,
  startToCloseTimeout: "3 minutes",
  heartbeatTimeout: "10 seconds",
  retry: { initialInterval: "1 second", maximumAttempts: 2 },
});
```

Three minutes for a translation looks generous, and the activity sent a heartbeat every 3 seconds, well inside 10. So why did so many attempts die on the heartbeat timeout?

Because of two details that are easy to miss:

- **The timeout clock starts when the attempt starts, and an attempt starts when the worker receives the task, not when your code gets to run.** The translations waiting their turn on a pod weren't waiting in Temporal's queue. As far as Temporal was concerned, they had started.
- **Heartbeats need the event loop too.** A translation waiting its turn hadn't started its keepalive yet, so it sent nothing. The one being translated had a keepalive, but its heartbeats couldn't be sent while the loop was blocked. This doesn't depend on how the keepalive is built: in the Python SDK, every heartbeat is handed to the worker's event loop to be sent, including one called from an activity's thread.

So a translation timed out if 10 seconds passed without a heartbeat reaching the server. For one waiting in line, that meant its turn didn't come within 10 seconds of being accepted. With a few translations ahead of it, that was most of them.

It got worse from there. A translation that had already timed out while waiting still ran in full when its turn came: nothing had told the worker, and even if something had, there was no `await` at which to stop it. So part of each pod's single lane went into results the server would reject.

Meanwhile, Temporal retried the timed-out attempts. All of the activity's own errors were marked non-retryable, so `maximumAttempts: 2` came into play only for timeouts, and there were plenty of those. A retry could just as well land on another pod that was equally stuck.

With the TypeScript activity, none of this showed. An LLM call yields at its `await`, so many requests can wait in parallel on one event loop, and a short heartbeat timeout is harmless. The Python activity kept the same workflow call but stopped yielding, and that removed the conditions that had made the timeout harmless.

## Act IV: why 60 replicas made it worse

When a queue backs up, the natural reaction is to add workers. The deployment already scaled with KEDA on the task-queue backlog:

```yaml
minReplicaCount: 5
maxReplicaCount: 60
pollingInterval: 3
advanced:
  horizontalPodAutoscalerConfig:
    behavior:
      scaleUp:
        stabilizationWindowSeconds: 0
        policies:
          - type: Percent
            value: 100
            periodSeconds: 15
      scaleDown:
        stabilizationWindowSeconds: 3600
triggers:
  - type: temporal
    metadata:
      taskQueue: "translation"
      queueTypes: "activity"
      targetQueueSize: "1"
```

The backlog on the translation queue grew, and with it schedule-to-start latency, so the autoscaler did exactly what it was told. `targetQueueSize: "1"` asks for roughly one pod per waiting task, the replica count can double every 15 seconds, and the one-hour scale-down window keeps the pods once they exist. We went to the maximum quickly and stayed there.

Every new pod did add a lane. But it also brought the same problem with it:

1. The pod accepts up to 50 tasks and starts 50 clocks.
2. It works through them one at a time, and most of them time out, some of them while still taking up the lane.
3. Each timeout puts a retry back on the queue, alongside the new work.
4. The backlog grows, KEDA adds pods, and we go back to step 1.

Every pod also loaded its own copy of the models, so 60 replicas meant 60 copies in memory. The cluster paid for all that capacity and the queue barely moved, because much of it went into work that had already timed out. The number of pods wasn't the problem. Each pod accepting far more work than it could start was.

## Act V: threads, and what they didn't change

The first change was the obvious one: turn `async def` into `def`, so each activity runs on a thread from the pool and the event loop stays free.

Threads come with their own limitation. The model and tokenizer aren't safe to use from several threads at once, so local inference sits behind a lock. The lock covers only tokenization, `model.generate()` and model loading. Language detection and the LLM fallback run outside it.

```python
class MarianTranslator:
    def __init__(self) -> None:
        self._lock = threading.RLock()

    def translate(self, text: str) -> str:
        with self._lock:
            ...  # tokenize, model.generate(), decode
```

The second change was making sure every task the worker accepts gets a thread right away. Switching to `def` and keeping the old configuration would have meant 50 concurrent activities on 10 threads, with 40 tasks sitting in the executor's queue. They wouldn't have started their keepalive, so they'd time out exactly as before. The SDK logs a warning about this, but a warning is easy to miss, so I made the worker refuse to start instead:

```python
concurrency = settings.temporal_max_concurrent_activities
pool_size = settings.temporal_activity_max_threads
has_sync_activity = any(not asyncio.iscoroutinefunction(fn) for fn in activities)
if has_sync_activity and pool_size < concurrency:
    raise ValueError(
        f"temporal_activity_max_threads ({pool_size}) must be >= "
        f"temporal_max_concurrent_activities ({concurrency}) when running "
        "synchronous activities; otherwise activities queue without a worker "
        "thread and miss their heartbeat timeout."
    )

worker = Worker(
    client,
    task_queue=settings.temporal_task_queue,
    activities=activities,
    activity_executor=ThreadPoolExecutor(max_workers=pool_size),
    max_concurrent_activities=concurrency,
)
```

I set both values to 10: 10 threads and 10 concurrent activities per pod.

Here's what that changed:

- **Every accepted task starts heartbeating immediately.** It has its own thread, so its keepalive runs from the first second, even while it waits for the inference lock. Waiting no longer costs a heartbeat timeout. The limit for a waiting task is now the 3-minute `startToCloseTimeout`.
- **The LLM fallback no longer waits behind inference.** While one thread holds the lock, others detect languages and wait on LLM responses in parallel.
- **Each pod accepts only what it can start.** 10 tasks instead of 50.

And what it didn't change: **local inference still runs one at a time per pod.** Threads don't add inference capacity; they only make waiting safe. If translations needing the local model arrive faster than the pods can run them, they still queue up, now on the lock or in Temporal's queue instead of behind a blocked event loop.

The keepalive has a cost worth knowing about. It proves that the thread is alive, not that the translation is making progress. If `model.generate()` ever hangs, the keepalive will keep heartbeating until the 3-minute limit. And while threads fixed the cancellation problem from Act III in general (the SDK can raise a cancellation inside an activity's thread), it still can't interrupt a thread stuck inside a native call like inference.

## What I would do next

None of the following is implemented, so treat it as my reading of the problem rather than a proven fix.

- **Size concurrency for the lock, not the thread pool.** If one inference takes *t* seconds, a pod finishes at most 1/*t* local translations per second, however many threads it has. That's Little's law from the previous post again. Tasks waiting on one pod's lock can't be picked up by an idle pod, so accepting more than the lock can serve soon only moves the queue to the wrong place.
- **Split the two execution profiles.** Language detection plus the LLM fallback is mostly I/O and can run with high concurrency. Local inference is CPU-bound and serialized. Two activities on two task queues, with the workflow choosing between them, would let each queue have its own worker settings and its own scaling. Today, one setting has to fit both.
- **Scale on something the pods can actually drain.** Every pod adds one inference lane and one more copy of the models in memory. A target of one pod per waiting task buys mostly memory.
- **Heartbeat with progress, not just a pulse.** Including how far the translation got in the heartbeat details would at least make a stuck attempt visible.

## Why not keep `async def` and offload the work?

A fair question for Python users: why not keep the activity `async` and wrap the blocking calls in `await asyncio.to_thread(...)`?

You can, and the event loop would stay free. But you then have two concurrency limits, `max_concurrent_activities` and the size of whichever executor you offload to, and they must agree for the same reason as above. You also have to find and wrap every blocking call, and the next one someone adds will freeze the loop again. A plain `def` activity with an explicit `activity_executor` puts both limits in one place, in the worker configuration, where the next person will look. It also matches what the SDK recommends as the default.

## Takeaways

1. **An activity's execution profile is part of its contract.** The workflow call and the types stayed the same. Timeouts, worker concurrency and autoscaling were set up as if it were still a network call.
2. **A blocking call in an `async def` activity stops the whole worker.** Not just that activity: every activity on that pod waits, whatever `max_concurrent_activities` says.
3. **"Started" means handed to a worker, not running.** Timers run from the moment the worker receives a task, including the time it waits inside the pod.
4. **A task can only heartbeat once it is running.** On a blocked event loop or without a free thread, it can't. For synchronous activities that heartbeat from their own thread, that means the pool must have at least as many threads as concurrent activities.
5. **A lock defines the real capacity.** Threads make waiting safe; they don't make serialized work parallel.
6. **Replicas can't fix a bottleneck inside each pod.** With a backlog-based scaler and retries, they can turn it into a feedback loop.

## How it ended

Moving the activity off the event loop, and running it with 10 threads and 10 concurrent activities per pod instead of 50, made the timeouts largely go away. It didn't solve the underlying problem, though: for translations that need the local model, the capacity of the whole system is still the number of pods divided by the time of one inference.

The practical lesson: when you swap the implementation behind an activity, check its execution profile, not just its signature. Ask where it spends its time, what that does to the worker it runs on, and whether the timeouts, concurrency and scaling settings still describe it.
