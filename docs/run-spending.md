# Spending for each run

On **Confirm**, after choosing the reader, set the run's spending under **Spending limit**:

- **Stop this run if spending reaches**: all recorded model spending for the run combined.
- Under **More spending options**, separate limits for each system: **Stop if OpenAI spending reaches** covers the reader and heading recovery, and **Stop if TypeSafe spending reaches** covers the confidence check. With Qwen 3.8 27B or DeepSeek Flash as the reader, the first is named after both services paid for reading ("Stop if Cloudflare and OpenAI spending reaches", or DeepSeek and OpenAI), because heading recovery stays on OpenAI.

An empty field has no separate limit. Any configured limit can stop further calls. All-empty inputs are not permission for unlimited spending: choose **Run with no spending limit** and tick its acknowledgement. Your signed-in identity, decision and confirmation time are recorded for the run. Retrying failed documents starts a new run and asks again.

The app records usage returned by each vendor and converts it with the run's recorded prices, including retries. It displays the known combined and per-system subtotals. Missing usage is flagged, never treated as free. This is model usage for this run at published prices, not your vendor invoice, a free-allowance balance or Cloudflare's infrastructure bill. DeepSeek calls are always counted at DeepSeek's peak price, even when its half (off-peak) price applies, and Qwen's reported cached input is counted at the full input rate.

Limits stop new calls when recorded spending reaches them. They cannot cancel charges already incurred, and they are not guaranteed maximum bills. Parallel Interactive calls can be in flight together and can exceed a threshold before the app sees their usage. Stopping does not erase completed work. New runs do not offer Batch mode.

A trial and the subsequent full run have separate spending confirmations. Trial confirmation starts no paid work. The full run's default selection includes the trial documents; every selected document is classified and charged again.

The app requires no pre-run cost prediction. The confidence check receives full extracted text and structure without a local token counter. Actual token counts arrive with vendor responses.

## Daily allowances on a shared site

A site can also set daily allowances for everyone (the owner pack's `settings.usageLimits`, DECISIONS 134 and 136). They apply as well as each run's own limits, never instead of them. On the owner's site: at most 60 documents per run; 3 new runs per person per UTC day (a trial and its first full run count as one; category editors and the owner's trusted users have no run-count cap, DECISIONS 150); 225,000 tokens a day for GPT-5.4; 2,250,000 shared by GPT-5.4 mini and heading recovery; 9,000 Cloudflare Neurons for Qwen; USD 0.50 for DeepSeek, counted at the peak price; and USD 1 for TypeSafe. **Daily allowance** on Confirm shows them, with today's usage.

Each model call reserves an upper bound on its usage before it is sent, and the reservation settles from the vendor's reported usage. While other runs hold an allowance, a document waits and asks again. A run stops with a plain reason when the day's settled usage leaves no room, or when the allowance stays held for 30 minutes; it never switches to another reader. A call whose usage stays unknown closes that allowance for the rest of the UTC day. The allowances reset at 00:00 UTC.

They are not a strict calendar-day ceiling. Calls still in flight at 00:00 UTC count on the new day once they settle, and use of the same vendor accounts outside this site is not seen (DECISIONS 136 clarification, DECISIONS 140). Nothing here promises a zero invoice.

## Stopping a run

You can stop your own run while it is being sorted with **Discard this run…** on its Progress screen. New calls stop, its uploaded text is deleted and it never has a results file. Charges for calls already sent are still recorded, and the spending check runs when the run closes. Only the site owner (a listed category editor) can stop every run on the site, from **System**. Neither stop restarts anything by itself.

## Unresolved charges and isolated failures

From 1 October 2026 new runs explicitly recorded `not-processed-zero-v2` as their unknown-spend policy, and from 9 October 2026 `not-processed-zero-v3` (below); earlier runs keep theirs. If a vendor request has no verified cost in a run whose owner acknowledged unlimited spending, that document receives a processing-failure outcome. The failed/unknown-cost attempt is not retried automatically. Other documents may continue. The known spend subtotal and number of unresolved charges remain visible, including after classification completes; unknown is never converted to zero or a final invoice total.

The narrow `not-processed-zero-v2` exception applies only when the retained response is within the readable-size bound,
returns no usage, and is HTTP 429 or a 5xx with an empty/whitespace-only body. That attempt is recorded at zero under the
owner-selected policy and ordinary retries may proceed. Returned usage is always priced. Oversized bodies, network failures
and all other unaccounted responses remain unknown; an unreadable response is never evidence of zero cost. Frozen earlier
runs retain their recorded policy. This is the application's accounting policy, not a vendor invoice guarantee.

`not-processed-zero-v3` (owner decision of 9 October 2026, DECISIONS 152 evening addendum) does everything
`not-processed-zero-v2` does, plus one recorded answer: TypeSafe refusing a document's confidence request as too large,
an HTTP 400 whose retained body is a JSON object with `error_type` exactly `max_tokens_exceeded` and no usage. That attempt
is recorded at zero, is not an unresolved charge, settles its TypeSafe daily reservation at zero, and is not sent again.
The document is set aside as could not be processed with a plain reason ("TypeSafe refused this document as too large for
the confidence check…"), and the run continues, a run with a spending limit included. It is not part of "New run with the
unfinished documents", because its size does not change: sort it yourself, or split it and include the parts in a new run.
Any other 400, a malformed body, a body too large to read, and a reader's 400 stay unresolved charges exactly as under
v2. Runs that recorded `not-processed-zero-v2` keep it. The owner accepts the residual: if TypeSafe did bill a refused
request the site would not see it; at the 64,000-token input ceiling and the recorded rate that is at most about USD 0.003.

For runs with any spending limit, an unresolved charge stops admission of new requests because compliance with the recorded limit cannot be established. Completed work and retained responses stay saved. Further work requires an explicit new spending decision; existing halted runs are not automatically restarted or rewritten. In-flight work is still accounted when its response arrives.

This exception does not bypass the stop of all runs, disabled model calls, credential failures, model-identity checks, or inability to retain evidence. Runs made before 1 October 2026 keep the policy they recorded: `isolate-unlimited-v1`, or, for historical runs without an unknown-spend policy, their recorded halt-on-unknown behavior. This policy changes admission and failure isolation, not category decisions or reported usage arithmetic.
