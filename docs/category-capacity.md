# Why 254 categories is a ceiling, not a target

Written 1 October 2026 for anyone who reads "up to 254 categories" in the scope and wonders why a project with far fewer is
refused above a few dozen. Decisions 68, 95, 97, 98 and 100 in `DECISIONS.md` carry the record; this page is the explanation.

## Where 254 came from

The confidence check's "which category is this?" question accepts at most 255 options, and one of them is "none of these".
254 was therefore the largest category list the schema could carry. It was never a measurement of what the two model prompts
can hold beside a document. The project's schema still refuses a 255th category; nothing above says it should accept 254.

## What actually limits the count

Every document is its own request to each model. Beside the document's text, a request carries the category definitions:

- the reader gets every definition in full and answers one verdict per category; its answer must fit the reader's output
  allowance, which under the current answer format holds about 89 categories (a compact answer format, switchable and off
  by default, holds far more);
- the confidence check gets one yes/no question per category, each carrying that category's full definition, plus one choice
  question that repeats every definition inside its list of options. Under grouping, both that choice question and each
  individual yes/no question must fit; an unusually long individual definition can make its yes/no question the binding limit.

The limits are computed from the real definitions at draft creation, activation and new-run admission, and shown on Health; an oversized set is
refused up front with the numbers, instead of failing late in the vendor's response and being billed twice.

## The numbers today

With definitions the size of the owner's (about 450 characters each) and the cautious token rule in force (one byte counts
as one token until the vendors' own recorded usage grounds a ratio), about 17 categories fit one confidence request; about
69 when the questions are split across several requests (grouped questions, a switchable setting, off by default); 254 only
once the token ratio is grounded or the choice question is shortened.

## Why we are not pushing to 254

1. **No present need.** No client taxonomy has been supplied (`HANDOFF-REMOTE.md` section 1); the four active categories are random test fixtures from the corpus used for testing, which is a harness, not a client set (DECISIONS 36, 101).
2. **Each lever has a cost.** Grounding the token ratio is a measured average and can over-estimate the room for unusual
   text; grouping bills the document's text once per request and multiplies the failure surface; shortening the choice
   question gives one model a thinner view of each option and is a prompt change that must be compared live.
3. **Refusing early is the safe default.** A loud "no" with the numbers is better than a silent, double-billed failure.
4. **It is reversible on evidence.** When a real client set needs more, the ratio will have been grounded (the archive of the
   earlier runs returns the figures), grouping is built, and the choice-question change is a decision for that set, with a
   live comparison before it becomes a default.

## What a client with many categories should expect

Health shows the capacity for the settings in force. If a set is refused, the sentence names the limit and the count. The
first remedy is the grounded token ratio (no change of meaning); the second is grouped questions (more cost, no change of
meaning); the third is a compact reader answer and a shorter choice question (a change of what one model is asked, compared
live first). None of the three switches on by itself.
