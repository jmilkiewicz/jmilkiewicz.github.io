---
title: "The compiler stopped guarding the pipe: how rewriting an activity in Python broke our Temporal contract"
description: "How rewriting a Temporal activity from TypeScript to Python silently broke the contract, why Zod 3 and Zod 4 validate the same schema differently, and how changing the data shape fixed it."
tags: [temporal, typescript, python, zod, contract-first]
series: "Temporal in production"
series_part: 1
---

I spent nine months working with [Temporal](https://temporal.io/) almost every day: designing workflows, debugging them in production and digging into how they work under the hood. That left me with plenty of stories worth writing down. This is the first post in a planned series (4-5 posts). I'm starting with a relatively simple topic, because it shows well how easily "working" code turns out to be fragile once two different languages sit on either end of the pipe.

The examples are simplified and anonymized (snacks instead of the real domain). You can run all of the code yourself, no Docker needed: [temporal-polyglot-playground](https://github.com/jmilkiewicz/temporal-polyglot-playground).

## Act I: everything in TypeScript

In the beginning it was simple. Workflow and activity were both written in TypeScript, and I was handed the interface between them "from above". It just worked. The activity checked whether a given snack is sweet, salty or spicy, and returned this type:

```ts
type SnackCheckResult = {
  flavors: Record<SnackFlavor, boolean> | null;
  caption: string | null;
};
```

The workflow used it like this:

```ts
function workflowLogic(snackCheckResult: SnackCheckResult) {
  const { flavors, caption } = snackCheckResult;
  if (flavors !== null) {
    return { isSweet: flavors.SWEET, caption };
  }
  return { isSweet: false, caption };
}

export async function snackWorkflow(args: SnackCheckArgs): Promise<SnackWorkflowResult> {
  const snackCheckResult = await checkSnack(args);
  return workflowLogic(snackCheckResult);
}
```

I had inherited this code and never paid attention to how exactly it worked. The realization came fairly quickly, though: **the compiler was a validation layer that nobody was thinking about.** On the activity side, TypeScript would not let you push anything into the pipe that wasn't a valid `SnackCheckResult`. Temporal serialized it, the workflow deserialized it, and everyone was happy.

## Act II: enter Python

Then came a natural need: the snack-detection logic would be better written by the ML people, and they work in Python. Part of the activities was rewritten. Not a single line of the workflow changed, and neither did the interface.

Except that the `SnackCheckResult` type stopped being a contract and became a **wish**. The Python side never sees it, the TypeScript compiler has no idea what actually arrives over the wire, and the type in the workflow code keeps reassuring everyone who reads it.

How easy is it to get this wrong? Plain Pydantic is enough (an illustrative example, not taken from the project):

```python
class SnackCheckResult(BaseModel):
    flavors: dict[str, bool] | None = None
    caption: str | None = None

SnackCheckResult(caption="a cookie").model_dump(exclude_none=True)
# {'caption': 'a cookie'}   <- the "flavors" key simply isn't there
```

`exclude_none=True` is a common, reasonable habit on the Python side. From TypeScript's point of view, though, it breaks the contract: a field that according to the type always exists (even if as `null`) has vanished.

We switched over to the Python activity and at first everything worked. Time to open the champagne.

## Act III: a test that had nothing to do with the topic

The trouble surfaced during internal tests that were completely unrelated to this part of the system. The workflow started falling apart, and we had nothing configured that would have made it obvious why. The reason is that a plain `TypeError` thrown from workflow code **does not fail the workflow**. It fails the *workflow task*, which Temporal retries forever, so in practice the workflow just hangs.

Only in tests, after setting this:

```ts
const worker = await Worker.create({
  connection: testEnv.nativeConnection,
  taskQueue,
  workflowBundle,
  activities: { checkSnack },
  // By default a plain Error thrown from workflow code fails the workflow *task*, and the
  // task is retried forever: the workflow just hangs. Promote TypeError to a workflow
  // failure so the test can observe the exception instead of timing out.
  workflowFailureErrorTypes: { "*": ["TypeError"] },
});
```

were we able to see the actual exception: `TypeError: Cannot read properties of undefined (reading 'SWEET')`. That message, however, points at the place that detected the problem (the consumer), not the place that caused it (the producer).

To get to the truth, we had to open the Temporal UI and look at the activity's output. It turned out that **there was no `flavors` at all** in that output. Python had simply omitted the field.

## Act IV: the quick fix

One of the developers decided he knew how to fix it quickly: add validation of the activity result with Zod. We already had Zod in the project, so a schema describing the same type was trivial (Zod 3, which was what we were on at the time):

```ts
flavors: z.record(SnackFlavor, z.boolean()).nullable()
```

It was a good idea, but I wanted to check whether the validation really catches everything Python might send. I asked for tests with payload variations: missing flavors, lowercase keys, unknown keys. And my hunch paid off, because one test failed.

To simulate Python without running Python, the tests register activities written in TypeScript that return exactly the payloads Python would produce, and I push them past the compiler with `as unknown as`. That's an important detail: **to simulate Python, I have to cheat the compiler.** In a single-language world these bugs would be impossible.

Let's take a realistic payload: the producer returns only the flavors it considered relevant.

```ts
missingSweet: async () =>
  ({
    flavors: { SPICY: false, SALTY: true },
    caption: "dried fish",
  }) as unknown as SnackCheckResult
```

Here are two tests that differ only in which Zod import path they use:

```ts
it('still loses isSweet on a partial record validated with "zod/v3"', async () => {
  const partial = await runSnackWorkflow(
    pythonCheckSnackVariants.missingSweet,
    snackWorkflowWithValidationZodV3,
  );

  expect(partial).not.toHaveProperty("isSweet");
});

it('rejects a partial record validated with "zod/v4"', async () => {
  const error = await runSnackWorkflow(
    pythonCheckSnackVariants.missingSweet,
    snackWorkflowWithValidationZodV4,
  ).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(WorkflowFailedError);
  const cause = (error as WorkflowFailedError).cause;
  expect(cause).toBeInstanceOf(ApplicationFailure);
  expect(cause).toMatchObject({
    type: SNACK_CHECK_VALIDATION_ERROR,
    details: [{ invalidFields: ["flavors"] }],
  });
});
```

Same schema, the very same line `z.record(SnackFlavor, z.boolean())`. In Zod 3 the validation **passes**, and `isSweet` still disappears. In Zod 4 the result is rejected with a readable error that points at the `flavors` field, that is, at the producer.

The reason: with enum keys, Zod 3 treats the record as **partial**, while Zod 4 treats it as **exhaustive**. So whether validation protects you from an incomplete record depends on the import path (`"zod"` versus `"zod/v4"`). The first test deliberately documents the gap (hence "still loses"). If someone closes it one day, the test will start failing.

By the way, this mismatch is already visible in the types themselves. In Zod 3, `z.infer` for such a schema gives `Partial<Record<SnackFlavor, boolean>>`, not the `Record<SnackFlavor, boolean>` our type promises. So Zod was telling us outright that some keys might not exist, and we went on validating a "contract" that doesn't allow for that. We saw the difference, but decided it didn't matter and brushed it off. Only a test on a realistic payload showed that this "detail" hides the loss of `isSweet`.

We had installed validation and felt safe, but we weren't. **A false sense of security is more dangerous than none at all.**

The worst part is that the naive version has three variants in which nothing visible happens:

| What "Python" sends | Naive workflow |
|---|---|
| `{ caption: "a cookie" }` (no `flavors`) | `TypeError`, workflow hangs |
| `{ flavors: { SPICY: false, SALTY: true }, ... }` (incomplete record, no `SWEET`) | **Silence.** Result without `isSweet` |
| `{ flavors: { sweet: true, ... } }` (lowercase keys) | **Silence.** The payload says "sweet", the system detects nothing |
| `{ flavors: { ..., UMAMI: true } }` (unknown key) | **Silence.** `isSweet: true`, the extra key goes unnoticed |

The missing `isSweet` happens because `undefined` is dropped during JSON serialization, so the client receives `{ caption: "a cookie" }` even though the type promises `isSweet: boolean`.

## Act V: the question that should have come earlier

At this point I started wondering not about yet another patch, but about something different: **why is this interface so complicated?**

`Record<SnackFlavor, boolean>` makes sense as a method parameter in TypeScript. The compiler enforces completeness, and access by key is convenient. As a contract between languages, though, it is very brittle, because every language has its own idea of a missing field, `null`, an empty value and keys. It resembles a situation where, instead of a *contract first* approach (a contract described independently, like XML Schema in SOAP or JSON Schema in OpenAPI, and only then "translated" into each language), we do plain RPC on functions specific to one language and **hope that the other side's runtime will somehow adapt**.

If the shape of the data itself allows "incomplete" states, you can either detect them or change the shape so that they don't exist at all. I chose the latter:

```ts
import { z } from "zod";
import { SNACK_FLAVORS } from "../types";

const SnackFlavor = z.enum(SNACK_FLAVORS);

export const SnackCheckResultV2 = z.object({
  flavors: z.array(SnackFlavor).nullable(),
  caption: z.string().nullable(),
});
export type SnackCheckResultV2 = z.infer<typeof SnackCheckResultV2>;
```

The activity now returns **the list of flavors it found**. There is no such thing as an incomplete list: a flavor that isn't on the list simply isn't present. The workflow builds the full `Record<SnackFlavor, boolean>` locally from `SNACK_FLAVORS`.

The workflow itself also stops trusting what the activity promises:

```ts
async function checkSnackAndValidate(
  args: SnackCheckArgs,
  schema: ActivityResultSchema<SnackCheckResultV2>,
): Promise<SnackWorkflowResult> {
  // The activity's declared return type is not trusted: the payload is validated at runtime.
  const raw: unknown = await checkSnack(args);
  const { flavors, caption } = parseActivityResult(raw, schema);
  if (flavors === null) {
    return { isSweet: false, caption };
  }

  const flavorRecord = Object.fromEntries(
    SNACK_FLAVORS.map((flavor) => [flavor, flavors.includes(flavor)]),
  ) as Record<SnackFlavor, boolean>;

  return { isSweet: flavorRecord.SWEET, caption };
}
```

The `const raw: unknown` line expresses the whole lesson of this post: *a TypeScript type is not proof, it's a declaration*. The compiler won't let you use `raw` without going through validation. The record is rebuilt so that the rest of the workflow keeps working on the full type, as before.

The results are identical in Zod 3 and Zod 4:

| Activity | Payload | Result |
|---|---|---|
| `sweetCandy` | `{ flavors: ["SWEET"], ... }` | `isSweet: true` |
| `spicyOnly` | `{ flavors: ["SPICY"], ... }` | `isSweet: false` (correct) |
| `lowercaseFlavor` | `{ flavors: ["sweet"], ... }` | rejected |
| `unknownFlavor` | `{ flavors: ["SWEET", "UMAMI"], ... }` | rejected |

Note `spicyOnly`. It is the counterpart of the incomplete record that previously led to a silent failure. Now it's a perfectly valid payload with the correct answer. Lowercase and unknown flavors are caught because the *elements* of the array are validated, and the Zod import path no longer matters.

Responsibility has shifted too. Before, the producer had to remember to be complete. Now completeness follows from the shape of the data, and the consumer fills in the rest.

## How to report a validation error

All of the error handling fits in a single function:

```ts
export function parseActivityResult<T>(raw: unknown, schema: ActivityResultSchema<T>): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "<root>"))),
    ];
    // A plain ZodError would only fail the workflow task and retry it forever. A non-retryable
    // ApplicationFailure fails the workflow execution loudly instead.
    throw ApplicationFailure.nonRetryable(
      `invalid activity result: ${fields.join(", ")}`,
      SNACK_CHECK_VALIDATION_ERROR,
      { invalidFields: fields },
    );
  }
  return parsed.data;
}
```

Two decisions:

- **`ApplicationFailure.nonRetryable` instead of a plain `ZodError`.** A plain exception would again hang the workflow task in a loop, repeating the `TypeError` problem. Here the workflow ends with a clear, named error you can set an alert on. Retrying makes no sense, because with a broken contract every attempt returns the same thing.
- **We report only the name of the top-level field.** No values and no Zod messages, which may quote the received data. `ApplicationFailure` details end up in the workflow history and are visible in the UI, so real data shouldn't leak there. And the answer to "which property failed" is exactly what someone with an alert in hand needs.

The `ActivityResultSchema<T>` interface describes only `safeParse`, the part common to Zod 3 and 4. That's how one function handles both schemas.

## Takeaways

1. **TypeScript types don't cross the language boundary.** As long as both ends of the pipe are in one language, the compiler does a job you don't know about. Add a second language and that job disappears without warning.
2. **Runtime validation at the boundary is necessary, but its mere presence proves nothing.** Zod 3 and Zod 4 behave differently for the same schema. Write tests that check that validation rejects what it should reject, not only that it accepts what it should accept.
3. **The most dangerous errors are silent.** A hanging workflow raises an alarm. A wrong `isSweet` doesn't.
4. **The error has to point at the producer.** The `TypeError` showed where we crashed. A named field in `ApplicationFailure` shows who broke the data.
5. **Best of all, change the contract so the invalid state can't be expressed.** An array instead of a record eliminates a whole class of errors instead of detecting them.
6. **For cross-language communication, think contract first.** The shape of the data should be simple enough for every language to produce and check without guessing what the other runtime will do.

## How it ended

The Python team appreciated the help with changing the contract, and the migration went smoothly. It wasn't a one-step move, though, but the classic three-step approach: add a new version of the activity next to the old one, switch the workflow to call the new one, and finally remove the old one.

The practical lesson for the future: contracts at language boundaries should be built contract first, on supported standards (JSON Schema, Protobuf or OpenAPI), from which every language generates its own code. That code doesn't have to be pretty or optimal from a purist's point of view, because it lives at the edge of the system (in the delivery mechanism), not in the domain logic. Zod at that boundary is a cheaper defense, but not a replacement for a shared schema.

All the code and tests: [github.com/jmilkiewicz/temporal-polyglot-playground](https://github.com/jmilkiewicz/temporal-polyglot-playground). Run them with `npm install && npm test`.
