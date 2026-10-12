# Stress test: 2,040 long research papers on the live site (12 October 2026)

**The short answer.** After the news test, we put 2,040 long research papers through the owner's live site: real arXiv papers in eight neighbouring fields, with formulas, tables and two-column pages, as PDF, Word and PowerPoint files. Again there was no training and no tuning. 1,797 papers got a decision; the other 243 were left unfinished when their runs stopped, and are not scored. Of the 1,797, it filed 1,006 (56%) on its own: 983 went to the right folder and 23 to the wrong one. It sent 351 (20%) to a person and could not process 440 (24%), most of them because they were too long for the certainty judge. Statistically, that means **fewer than 3.22% of the papers it files on its own go to the wrong folder, with 95% confidence.** It cost about 5½ US cents per paper.

Almost all the mistakes were in two fields that share a lot of mathematics: **information theory** (11) and **systems and control** (9). In the other six fields it misfiled 3 of the 793 papers it filed (0.38%).

This test was meant to be hard, and it was. It found two problems outside the classifier that stopped runs, and both were fixed during the test. It also found one limit that is not fixed: about one paper in five is too long for the certainty judge. See [What went wrong, and what changed](#what-went-wrong-and-what-changed) and [Papers too long for the certainty judge](#papers-too-long-for-the-certainty-judge).

![What happened to 1,797 long research papers: 983 filed in the right folder, 23 in the wrong one, 351 sent to a person, 440 could not be processed. Below, wrong answers among the papers each approach would file, on the 1,357 papers both judges answered: the reader alone 13.8% (187 of 1,357), Jev alone at certainty 0.90 or more 3.7% (40 of 1,078), and the product's rule, both judges agreeing with certainty 0.90 or more, 2.29% (23 of 1,006), 95% range 1.45% to 3.41%.](images/arxiv-accuracy.svg)

*Top: every decided paper's outcome. Bottom: the same papers and the same answers, with three different rules for when to file. As in the news test, requiring both judges to agree is what brings the error down.*

This page is written for two readers. The first half says what was tested and what the numbers mean, in plain words. [How the test was run](#how-the-test-was-run) and the sections after it give the method, the statistics and how to repeat it. The companion test on news articles is [docs/accuracy-test-bbc-news.md](accuracy-test-bbc-news.md); [how the two compare](#how-it-compares-with-the-news-test) is near the end.

---

## The results

| | Papers | Share |
|---|---|---|
| Filed automatically | 1,006 | 56.0% of all decided |
| … in the right folder | 983 | 97.71% of those filed |
| … in the wrong folder (a **misfile**) | 23 | 2.29% of those filed |
| Sent to a person (**needs review**) | 351 | 19.5% of all decided |
| Could not process | 440 | 24.5% of all decided |
| **Total decided** | **1,797** | |
| Not decided: left unfinished in stopped runs, not scored | 243 | |

**How sure we can be.** Any test on a sample has some luck in it: test a different set of papers and you would get slightly different numbers. A *95% range* is the band that the true rate falls in, 95 times out of 100, given what we saw.

- **Misfile rate:** 2.29%, 95% range **1.45% to 3.41%**. Put as a guarantee: the misfile rate is **below 3.22%**, with 95% confidence.
- **Review rate:** 19.5%, 95% range 17.8% to 21.4%. This is the share of papers left for a person. It measures work, not mistakes: a paper sent to a person has not been filed wrongly.
- **Could not process:** 24.5%, 95% range 22.6% to 26.5%. These papers were set aside with a reason, and nothing was filed for them. A person has to sort them by hand.

**By file type.** The Word and PowerPoint files here were made from the papers' PDFs (see [The files](#how-the-test-was-run)), so this shows the three reading paths, not three kinds of real-world document:

| Format | Decided | Filed right | Filed wrong | Misfile rate (95% range) | Sent to a person | Could not process |
|---|---|---|---|---|---|---|
| PDF | 1,476 | 796 | 17 | 2.09% (1.22%–3.33%) | 294 | 369 |
| Word | 221 | 131 | 4 | 2.96% (0.81%–7.41%) | 40 | 46 |
| PowerPoint | 100 | 56 | 2 | 3.45% (0.42%–11.91%) | 17 | 25 |

The three formats do not differ in any way the test can tell apart (see [the tests](#significance-tests)).

## Why two judges, and what they bought

Every paper is judged twice, by two systems that work differently (see [Two judges, not one](../README.md#-two-judges-not-one) in the README):

- **Jev** (TypeSafe's model, version 1.13.0) picks one category and says how certain it is. It also answers a separate yes or no for each category.
- **The reader** (Claude Sonnet 5.5, made by Anthropic) reads the whole paper and says yes or no for each category, quoting the paper to back each yes.

A fixed rule in code files a paper only when three things hold: both judges name the same single category, Jev's own yes or no for that category leans yes, and Jev's certainty is at least 0.90. Everything else goes to a person. No AI model makes the final decision.

What each part would have done on its own, on the 1,357 papers that both judges answered (all 1,006 filed papers are among them):

| Approach | Files | Wrong among those | Notes |
|---|---|---|---|
| The reader alone | every paper (1,357) | 187 (13.8%) | Its 187 include 24 answers that named no category and 75 that named two. |
| Jev alone, every paper | 1,357 | 165 (12.2%) | Jev's top choice was right on 1,192. |
| Jev alone, only when certainty ≥ 0.90 | 1,078 | 40 (3.7%) | |
| … and only when its own yes or no for that category leans yes | 1,028 | 30 (2.9%) | Jev checking itself. |
| Both agree, any certainty | 1,190 | 64 (5.4%) | |
| **Both agree, Jev's yes or no leans yes, and certainty ≥ 0.90 (the product)** | **1,006** | **23 (2.29%)** | |

So each judge alone was right about 87% of the time on these papers, against about 94% on news. Of the 40 papers Jev was sure about and got wrong, the rule sent 17 to a person instead of the wrong folder:

- **Jev's own yes or no held back 50 papers.** Jev named a category with certainty 0.90 or more, but asked directly whether the paper fits that category, it said probably not (for 2 of the 50 the reader also said the paper fits two categories). 10 of the 50 were Jev's mistakes.
- **The rest of the rule held back 22 more,** 7 of them Jev's mistakes. In 20 the reader said the paper fits two categories, in 1 it named none, and 1 was held back by a reading note.

The reader never named a different single category from a confident Jev. Its value here was saying "this fits two" when Jev was confidently wrong. The price is the review pile: one paper in five waits for a person.

## Where the mistakes were

| Category | Decided | Filed right | Filed wrong | Misfile rate among filed | Sent to a person | Could not process |
|---|---|---|---|---|---|---|
| Computer vision | 223 | 125 | 1 | 0.8% | 72 | 25 |
| Data structures and algorithms | 221 | 135 | 0 | 0% | 7 | 79 |
| Information theory | 223 | 72 | **11** | **13.3%** | 85 | 55 |
| Neural and evolutionary computing | 230 | 148 | 1 | 0.7% | 40 | 41 |
| Programming languages | 229 | 118 | 0 | 0% | 35 | 76 |
| Systems and control | 219 | 121 | **9** | **6.9%** | 61 | 28 |
| Group theory | 228 | 154 | 1 | 0.6% | 21 | 52 |
| Statistics theory | 224 | 110 | 0 | 0% | 30 | 84 |
| **All** | **1,797** | **983** | **23** | **2.29%** | **351** | **440** |

The 23 misfiles, by the answer key's label and the folder they went to:

- 7 labelled *Information theory* filed in *Statistics theory*;
- 6 labelled *Systems and control* filed in *Information theory*;
- 4 labelled *Information theory* filed in *Data structures and algorithms*;
- 1 labelled *Systems and control* filed in each of *Statistics theory*, *Neural and evolutionary computing* and *Data structures and algorithms* (3 in all);
- 1 labelled *Group theory* filed in *Data structures and algorithms*;
- 1 labelled *Computer vision* filed in *Neural and evolutionary computing*;
- 1 labelled *Neural and evolutionary computing* filed in *Statistics theory*.

The two most common confusions are named in the category definitions themselves as "most easily confused with" (see [the definitions](#the-category-definitions)). The definitions warned both judges, and both still agreed on the wrong one. Every misfile had Jev certainty of 0.90 or more (18 of the 23 at 0.95 or more), and both judges named the same wrong category. That is the failure mode two judges cannot catch: both confidently wrong in the same way.

The label is the field the authors chose as the paper's main one on arXiv. The 23 were not re-examined, so any of them could be a debatable label. A paper can also be listed under several fields. Only 3 of the 23 went to a field the authors had also listed it under, as far as these eight fields go.

Two fields carry 20 of the 23 misfiles. That cannot be luck (see the tests below). So the error rate depends heavily on which categories sit next to each other. It is not one number for "research papers".

## What went to a person, and why

Every review carries the rule that sent it (the rule table is in the README and [DESIGN.md §5.6](../DESIGN.md#56-decide)):

| Rule | Why it went to a person | Papers | Of those, what the answer key says |
|---|---|---|---|
| R5 | The two judges did not agree (see the split below) | 204 | The reader's answer matched the key in 145, Jev's top choice in 116; both can match |
| R3 | The reader said the paper fits two categories | 75 | The right category was among the reader's two in 72 |
| R2 | Both judges agreed, but Jev's certainty was below 0.90 | 52 | 41 of the 52 agreed answers were right |
| R4 | Both judges said it fits no category | 19 | All 19 had a category in the answer key; 9 were systems and control |
| R0n | A reading note that always asks for a person (a page with no text) | 1 | Both judges had it right |

The 204 disagreements were of three kinds:

- **131: both named the same category, but Jev's own yes or no for it was below 0.5.** 101 of these agreed answers were right. This is the most common reason a paper went to a person. It is the price of Jev checking itself, which also caught 10 of its confident mistakes (above).
- **68: they named different categories.** The reader was right in 44 and Jev in 10.
- **5: the reader named no category.** Jev's choice was right in all 5.

The most common pairs in the reader's "fits two" answers were computer vision with neural and evolutionary computing (23) and information theory with statistics theory (10).

R2 shows what the 0.90 threshold costs: 41 of those 52 papers would have been filed correctly, and 11 wrongly. As in the news test, that is the threshold doing its job, not a reason to change it from one test. The product never changes a threshold by itself, and a person decides from their own corrected runs ([DESIGN.md §10](../DESIGN.md#10-bake-off)).

## What could not be processed

| Reason | Papers | Share of decided | What it means |
|---|---|---|---|
| Too long for the certainty judge | 370 | 20.6% | TypeSafe refused the paper as larger than Jev accepts. The paper was set aside at no charge before the reader was asked. |
| The reader's quotes did not match the paper | 66 | 3.7% | Claude's answer quoted the paper, but not word for word under the quote rule in force. The answer got one identical retry, and the paper was set aside when that failed too. |
| The AI service's network turned the request away | 4 | 0.2% | Anthropic's network refused the call before it reached the model (see [below](#what-went-wrong-and-what-changed)). That paper alone failed, at no charge. |
| **All** | **440** | **24.5%** | |

Nothing was guessed. Each paper is in *Could not process* with its reason, and a person can sort it or include it in a new run. By field, "too long" hit statistics theory (77), programming languages (71) and algorithms (68) hardest, and computer vision least (12).

### Papers too long for the certainty judge

Jev reads at most about 32,000 tokens per request, the paper and the question together (a *token* is the unit AI services count text in, a few characters long). The kit was planned with the usual rule of thumb of 4 characters per token. By that rule, 63 of the 2,040 papers (3.1%) would be too long. In fact 370 of the 1,797 decided papers (20.6%) were.

The fix study measured about 2.67 characters per Jev token on these papers, on 421 accepted requests (one in ten below 2.27, one in ten above 3.08). Formulas, symbols and unusual words cost more tokens per character than ordinary prose. So the character count is a poor guide. The shortest refused paper had about 58,800 characters, yet 499 of the papers both judges answered were longer than that and went through.

This is a limit of the certainty judge, not of the rules. Sending Jev only part of a long paper would change what a judge sees. The design forbids that without a decision, and the owner's earlier rule says a too-long document is recorded and told to the person. **The owner decided** ([DECISIONS 156](../DECISIONS.md#156-a-claude-reader-claude-sonnet-55-for-the-accuracy-test-paid-from-a-usd-100-anthropic-credit), addendum of 12 October 2026) to keep recording these papers for now. A later side-by-side test on only these papers will choose between two options. One is a defined partial text for the certainty judge, with its own threshold earned from corrections. The other is Clef, Cloudflare's certainty model, which reads twice as much (see [Future direction](../README.md#-future-direction) in the README).

## Cost and time

**Cost, as recorded by the site,** across all 18 runs of the test, the stopped ones included:

| Phase | Runs | Reader (Claude) | Jev | Total | Papers decided |
|---|---|---|---|---|---|
| Batches of 60 | 16 | USD 41.43 | USD 0.66 | USD 42.09 | 731 |
| One-paper proof of the new route | 1 | USD 0.08 | USD 0.00 | USD 0.08 | 1 |
| The one large run | 1 | USD 55.21 | USD 0.83 | USD 56.04 | 1,065 |
| **All** | **18** | **USD 96.71** | **USD 1.49** | **USD 98.20** | **1,797** |

- **About USD 0.055 per decided paper**, or about USD 0.068 of reader spend for each of the 1,423 papers the reader actually read. A news article cost about USD 0.01. A paper that was too long for Jev cost almost nothing, because it was set aside before the reader.
- **Recorded spend may overstate the bill.** It uses list prices (Claude Sonnet 5.5 at USD 2 per million input tokens and USD 10 per million output tokens). The project pack prices a cache read at USD 0.20 per million tokens; Anthropic's pricing page says USD 0.10. The reader column also carries the small heading-recovery model used for the few PDFs that needed their headings found (GPT-5.4 nano, on OpenAI's free allowance). The owner's Anthropic console is the authority on what was billed.
- **It was paid from the same USD 100 credit as the news test** ([DECISIONS 156](../DECISIONS.md#156-a-claude-reader-claude-sonnet-55-for-the-accuracy-test-paid-from-a-usd-100-anthropic-credit)). The owner allowed the test to use the whole credit. The large run ended on the site's own Claude allowance of USD 100 a day, not on the credit.

**Time,** measured by the test runner on 12 October (UTC):

- **Batches of 60:** from the start of a batch to its last decision, 3 min 14 s to 8 min 57 s (median 4 min 9 s, over the 11 batches that finished). That is reading on the test computer, about 1 to 2½ minutes; sending the text, about 1¼ to 4¼ minutes; and processing, about ½ to 1½ minutes.
- **The one large run, 1,079 papers:** 48½ minutes from start to stop. Reading took about 16½ minutes, including putting the files into the browser first; sending the text took about 22 minutes (about 0.8 papers a second); processing took about 9½ minutes once everything was sent (about 110 to 120 papers a minute).
- **Reading speed depends on the computer.** An earlier attempt on the same computer read only 801 of the same papers in 20 minutes. The [local reading benchmark](local-reading-benchmark.md) has the measurements and how to measure your own machine before a large run.

## What went wrong, and what changed

The test ran from 05:26 to 10:34 UTC on 12 October. Eight things stopped or slowed it. Each is listed with its cause and what was done. Two were fixed in the product during the test; the rest were in the test tooling or the test computer, or were the product working as designed.

1. **The certainty judge's "too long" reply came in a new shape.** The first run stopped at once, with nothing decided. TypeSafe now nests its "too large" error inside an extra layer. The site knew only the old shape, so it treated the reply as a charge it could not account for and paused the run, as the spending rules require for anything unrecognised. **Fix:** a new spending policy, `not-processed-zero-v6`, recognises both shapes. Such a paper is set aside at no charge and the run carries on. It was built test-first and deployed before the second batch; older runs keep their own policy (DECISIONS 152, addendum of 12 October 2026).
2. **Anthropic refused calls that left Cloudflare from Hong Kong.** Three runs (batches 8, 16 and 18) stopped after a few papers. Cloudflare decides which data centre runs each document's job, and on some runs it chose Hong Kong. Anthropic does not serve Hong Kong, and its network refused every call from there (26 refused calls, all from Hong Kong). Calls from Singapore and elsewhere went through. The product's rule is that a refusal like this fails only its own document. Three failed documents in a row stop the run on purpose, because a real block would hit every document. Cloudflare cannot place a document's job (a Workflow) in a chosen region. **Fix:** a small helper Worker (a separate Cloudflare program) placed near Singapore now sends the calls to the reader models (those that go through Cloudflare's AI Gateway), with nothing else changed; the certainty judge's call and the document's job itself still run wherever Cloudflare puts them, and a placement is a request to Cloudflare, not a guarantee. A one-paper run proved the route: the reply came from Singapore. In the large run that followed, 1 call in 1,065 papers was still refused; only that paper failed. Where that one call left from was not checked for this write-up. [Where your text goes](data-residency.md) explains why text can be processed outside your country.
3. **Three quote failures in a row stopped a run.** Batch 15 stopped with 59 of 60 decided. Three papers in a row had reader quotes that failed the word-for-word check, and the same circuit that guards against a broken service counted them. **Kept as it is,** by the owner's choice: a reader that starts answering badly should stop the run quickly. With hard documents this can stop a run that would otherwise have finished.
4. **The test runner stopped two batches by mistake.** Batches 10 and 11 stopped on the Confirm screen before anything was sent. The runner checked which reader was selected while the page was redrawing, and saw the wrong one. **Fix (runner only):** the check waits for the redraw, and a real mismatch still stops the test. Those 120 papers went into the large run.
5. **The test computer lost its name lookup twice** (DNS, at 00:04 and 07:47 UTC): the runner could not find the site, started nothing, and said so. It was run again once the connection was back.
6. **The runner handed the browser 0.9 GB in one go.** The first attempt at the large run stopped before sending anything: the runner passed all 1,079 files to the page in a single call, and the page gave way. **Fix (runner only):** files are passed in 16 MB pieces.
7. **The runner had a fixed reading deadline.** The second attempt stopped after 20 minutes of reading, at 801 of 1,079, with nothing sent. The owner: "this pc processing time <> user pc processing time". **Fix (runner only):** the runner has no fixed deadline. It waits as long as the read count keeps rising, stops only after 10 minutes with no new file read, and logs the measured rate. The product's own reading screen never had a deadline. The third attempt read all 1,079 papers.
8. **The large run stopped on the site's own daily allowance,** with 14 papers unfinished, as designed: the site holds Claude to USD 100 a day. Papers already decided kept their outcomes; nothing was retried.

**The quote rule changed between the two phases.** After the fix study, the owner switched on a new quote rule, `layout-quotes-v2`, for new runs (DECISIONS 156, addendum of 12 October 2026). It forgives a few typesetting differences defined by published Unicode rules, such as a word split by a hyphen at the end of a line, or a ligature (one character standing for "fi" or "ff"). It still refuses a paraphrase or a changed word. The batches used the old rule and the large run the new one:

| Phase | Quote rule | Papers that reached the reader | Set aside for quotes | Rate (95% range) |
|---|---|---|---|---|
| Batches of 60 | `whitespace-quotes-v1` | 570 | 42 | 7.4% (5.5%–9.8%) |
| The one large run | `layout-quotes-v2` | 852 | 24 | 2.8% (1.9%–4.2%) |

The fall is large, but this is **not a controlled comparison**: the two phases read different papers, and nothing else was held fixed. The rule's own test was on held-out replies: it recovered 11 of 15 failures there, and refused nothing the old rule accepted.

Also changed for the test and then put back: the site's limit of 60 documents per run was raised to 2,000 for the one large run, and TypeSafe's daily cap from USD 1 to USD 5. Both are back to 60 and USD 1. The Singapore route and the new quote rule stay on.

## How it compares with the news test

| | 941 BBC News articles (11 October) | 1,797 arXiv papers (12 October) |
|---|---|---|
| Categories | 5, broad | 8, neighbouring research fields |
| Documents | short news articles, Word files | long papers (median about 58,600 characters, PDFs a median 18 pages), PDF, Word and PowerPoint |
| Filed automatically | 86.3% | 56.0% |
| Misfile rate (95% range) | 1.35% (0.67%–2.42%) | 2.29% (1.45%–3.41%) |
| Sent to a person | 13.6% | 19.5% |
| Could not process | 0.1% | 24.5% |
| The reader alone exactly right | 93.6% | 86.2% |
| Jev alone right | 94.8% | 87.8% |
| Cost per document | about USD 0.01 | about USD 0.055 |

The papers are harder in every way: longer, more technical, more categories, and closer together. Each judge alone dropped from about 94% right to about 87%. The two-judge rule kept the misfile rate in the same range: 2.29% against 1.35%, a difference the test cannot tell from luck (p = 0.17). It did this by filing fewer and sending more to a person. The large difference is in *could not process*: almost none on news, one in four here, mostly papers too long for the certainty judge. On collections of long technical documents, expect that pile until the too-long question is settled.

No published results are set against this test. Its papers were chosen for it (recent, openly licensed, at most 3 MB), so published scores on other arXiv collections do not measure the same thing.

---

## How the test was run

**The papers.** 2,040 research papers from arXiv, 255 in each of eight subject classes. The classes are eight of the eleven in the arXiv long-document set of He et al. (2019, github.com/LiqunW/Long-document-dataset). Three were dropped: artificial intelligence, too broad; computational engineering, a mixed bag; and commutative algebra, the smallest pool of openly licensed papers and a second pure-algebra class beside group theory. Each paper's label is its arXiv *primary category*, the first one in arXiv's own metadata, with arXiv's aliases folded together. The papers came from arXiv's metadata service and its public bulk-data bucket, the route arXiv names for full text. No paper was fetched from arXiv's website. Each download was checked against the bucket's checksum, and arXiv's rate limits were kept.

**The licences.** Only papers whose authors chose CC BY 4.0, CC BY-SA 4.0 or CC0 1.0 were used, so storing them, converting some to Word and PowerPoint, and sending their text to AI services for a private evaluation is plainly allowed. arXiv's metadata is CC0. No paper text, title or identifier is in this repository, and none will be. Only the scores are published, the project's rule for test documents.

**The stamp removal, and why it matters.** arXiv prints an identification line down the left margin of page 1 of most papers: the paper's number, its version, its **primary category** in brackets, and the date. That is the answer the test asks for. Left in, a judge could read the answer off the page, and the test would measure label-reading, not sorting. The stamp was found in 1,884 of the 2,040 papers and removed from every one. Each edited file was checked by reading it with the site's own reader: the text had to equal the original's minus exactly the stamp line. Two PDFs whose stamp sat inside an embedded picture could not be edited that way, and were made into Word files without the stamp line. What remains is genuine content: 59 papers cite other papers together with those papers' category codes.

**The files.** Per category, a seeded draw made 31 papers Word files, 15 PowerPoint files and the rest PDFs: 1,670 PDFs, 250 Word files (including the 2 above) and 120 PowerPoint files. The PDFs are arXiv's own files, with real two-column layouts, formulas, tables and figures. The Word and PowerPoint files were made from the text the site's own reader took from each PDF, line for line, with nothing added or reworded. Word files keep the headings; PowerPoint has one slide per PDF page. So they test the Word and PowerPoint reading paths, not real-world Office layouts. Everything was built on the owner's computer and uploaded through the site in the browser like any user's files: only text and outline left the machine.

**How the sample was drawn, and its biases.** Within each class, candidates were shuffled with a fixed seed (20261011) and taken in order while they met fixed rules: at least 8 pages; a file of at most 3,000,000 bytes; read without error by the site's own reader; and at most 8 papers per class above the kit's estimate of Jev's size limit. That last estimate turned out wrong (see [above](#papers-too-long-for-the-certainty-judge)). Before the targets were met, 918 candidates were skipped as too big a file, 402 as too short, and 373 under the size-limit quota. These rules shape the sample:

- **The 3 MB file cap removes picture-heavy papers.** It hit computer vision hardest: 573 of the 931 computer-vision candidates listed were over it. The computer-vision papers here are the lighter ones.
- **Only openly licensed papers.** Authors who choose CC licences may not write like everyone else.
- **Mostly 2025–2026.** 1,717 of the 2,040 papers (84%) were first posted in those two years. For the larger classes the candidate list was cut off early, so their papers come from the earlier part of that window. These recent papers are less likely than the 2004–2005 news articles to have been seen while the models were built, but that was not checked.

**The categories.** Eight categories written in plain language before the test, each with what belongs, what does not and why, and one generic example (listed [below](#the-category-definitions)). They were saved on the site as a new revision on 11 October and not changed during the test. No model saw the answer key. The site was never told the labels; scoring compared its outcomes to the key afterwards.

**The settings.** The owner's live site:

- Reader: Claude Sonnet 5.5, requested by name. Every reply in every finished run reported `claude-sonnet-5-5`, and no run stopped on a model change. Reader effort was low, with an output cap of 16,384 tokens, and calls went through Cloudflare's AI Gateway.
- Certainty judge: TypeSafe Jev 1.13.0.
- Threshold: 0.90, the starting value for new categories ("untested"), not one tuned on these papers.
- Spending policy `not-processed-zero-v6` throughout.
- The batches ran on build `00d3697`, with the quote rule `whitespace-quotes-v1`. The proof run ran on `67b3bb9`. The large run ran on `5216d79`, with the quote rule `layout-quotes-v2`, the Singapore route and a per-run limit of 2,000.
- The pilot step, a short check run before a large run, was skipped and labelled as skipped (DECISIONS 88), since every paper was scored.

**What ran.** The kit was dealt into 34 batches of 60. The 137 PDFs that needed their headings recovered by a small model were moved to the last batches, so the first batches sent no such request before the free allowance reset.

- **Batches 1–9 and 12–18** ran as 16 runs: 960 papers sent and 731 decided. Five of those runs stopped part-way (batch 1 on the new reply shape; 8, 16 and 18 on the Hong Kong refusals; 15 on three quote failures), leaving 229 papers unfinished.
- **Batches 10 and 11** were never sent (item 4 above).
- **One paper** proved the Singapore route.
- **The remaining 1,079 papers** went in one large run, which decided 1,065 before the daily allowance stopped it.

Unfinished papers were never re-sent. The owner chose to continue past each stop rather than repeat paid work ([DECISIONS 156](../DECISIONS.md#156-a-claude-reader-claude-sonnet-55-for-the-accuracy-test-paid-from-a-usd-100-anthropic-credit), addenda of 12 October 2026).

**The scoring.** Every decided paper counts, including those decided in runs that later stopped. A decision is final when it is recorded, whatever happens to the rest of its run. This differs from the news test, which left out its one stopped batch. A filed paper is right when its folder matches the answer key. The judges' answers used for "what each part would have done" are the ones each run stored with its decisions. They exist for the 1,357 papers both judges answered, and not for papers set aside before or during the reader's step.

### The statistics

All at 95% confidence, computed with `scripts/live-accuracy/stats.mjs`:

- **Misfile rate, 23 of 1,006.** The range is the Clopper–Pearson exact interval, 1.45%–3.41%. The Wilson score interval gives 1.53%–3.41%. "Below 3.22%" is the one-sided Clopper–Pearson upper bound.
- **Review rate, 351 of 1,797,** and **could not process, 440 of 1,797:** Wilson score intervals, 17.8%–21.4% and 22.6%–26.5%. Filed automatically, 1,006 of 1,797: 56.0%, 53.7%–58.3%.
- **The six fields outside information theory and systems and control:** 3 misfiled of 793 filed, 0.38%, range 0.08%–1.10% (Clopper–Pearson), below 0.97% with 95% confidence. **Those two fields:** 20 of 213, 9.4%, range 5.8%–14.1%.
- **By phase:** the batches misfiled 9 of 409 (2.20%) and the large run 14 of 596 (2.35%).
- **Each judge alone, on the 1,357 papers both answered.** Using the Wilson interval:

  | Judge | Right | Accuracy | 95% range |
  |---|---|---|---|
  | Reader | 1,170 of 1,357 | 86.2% | 84.3%–88.0% |
  | Jev | 1,192 of 1,357 | 87.8% | 86.0%–89.5% |

- **How many papers a stronger claim takes:** the table in the [news write-up](accuracy-test-bbc-news.md#the-statistics) applies unchanged.

### Significance tests

A significance test asks: could this difference be luck? The *p-value* is the chance of seeing a difference at least this big if there were really none. Below 0.05 is the usual line for "not luck". These were run on the recorded outcomes, with no change to any of them.

| Question | Test | Result | Verdict |
|---|---|---|---|
| Does the rest of the rule pick out Jev's confident mistakes, or hold papers back at random? Of the 1,078 papers Jev was sure about (certainty 0.90 or more, naming a category), the rule held back 72, and 17 of those were among Jev's 40 mistakes. Chance would catch about 3. | Hypergeometric test, one-sided | p = 4 × 10⁻¹¹ | **Not luck.** |
| The same for the last step alone. After Jev's own yes-or-no check, 1,028 papers remained, 30 of them mistakes. The reader's answer (and one reading note) held back 22, 7 of them mistakes, where chance would catch fewer than 1. | Hypergeometric test, one-sided | p = 1 × 10⁻⁶ | **Not luck.** |
| Is Jev alone (1,192 of 1,357 right) better than the reader alone (1,170 of 1,357)? Same papers, paired. | McNemar's exact test: Jev alone right on 66, the reader alone on 44 | p = 0.045 | **Barely**, and not after the correction below. Call them about equally good alone, as on news (p = 0.09 there). |
| Do information theory and systems and control misfile more than the other six fields (20 of 213 against 3 of 793)? | Fisher's exact test | p = 1.5 × 10⁻¹¹ | **Yes.** The errors sit where the fields overlap. |
| Is the misfile rate different from the news test (23 of 1,006 against 11 of 812)? | Fisher's exact test | p = 0.17 | **No difference shown.** |
| Did the batches and the large run misfile differently (9 of 409 against 14 of 596)? | Fisher's exact test | p = 1.0 | **No.** |
| Did the quote failures fall from the batches to the large run (42 of 570 against 24 of 852)? | Fisher's exact test | p = 9 × 10⁻⁵ | **Yes, but not because of the rule alone:** different papers, so not a controlled comparison. |
| Do PDFs and the Word and PowerPoint files differ (misfiles 17 of 813 against 6 of 193; could not process 369 of 1,476 against 71 of 321)? | Fisher's exact test | p = 0.42; p = 0.32 | **No difference shown.** |

Read these with care:

- **Nine p-values, not one.** With a strict correction for running several tests (Bonferroni: 0.05 ÷ 9 ≈ 0.0056), every "yes" above still holds. Jev against the reader (0.045) does not, so that one only suggests a difference.
- **How the groups were counted.** "Sure about" leaves out the 15 papers where Jev was 0.90 or more sure that *none* of the categories fit. That answer is never a filing, and the rule always sends it to a person. Counting them in as mistakes caught gives 32 of 55 caught among 1,093 and a far smaller p-value, but it adds nothing about Jev's real mistakes. "Reached the reader" leaves out the 4 papers whose call Anthropic's network refused, because their requests never reached the model.
- **A test against the news result assumes both are fair samples of their own kind of document.** It can tell luck from a real gap. It cannot make news and research papers the same kind of test.
- **What a significance test cannot do here.** It can't say whether 2.29% would hold on your documents or your categories. That needs your documents.

### What these numbers do not prove

- **They describe research papers in eight neighbouring fields.** The error rate swung from 0.38% in six fields to 9.4% in two. Your documents and categories may do better or worse. The way to know is to run your own documents and correct the results; the corrected run becomes your test set.
- **They take the answer key as right.** The label is the authors' own choice of main field. A paper on, say, estimation over a noisy channel could fairly sit in either of two fields. A debatable label shows up here as a misfile, or hides one.
- **The could-not-process rate belongs to these papers and Jev's size limit.** On news it was 0.1%. On long, formula-heavy documents, expect something like one in five until the too-long question is settled.
- **The sample was shaped by its rules:** openly licensed papers only, files of at most 3 MB (which removed most picture-heavy computer-vision papers), at least 8 pages, and a quota on papers expected to be too long.
- **The Word and PowerPoint files were made from the PDFs.** They show that those reading paths work. They say nothing about real-world Office documents.
- **243 papers have no decision.** They were in runs that stopped, and were never re-sent. They are whole batches, not chosen by outcome, so they should not bias the score. They are still papers the test did not measure.
- **One reader, one threshold, one day, and two quote rules.** The default GPT-5.4 reader was not run on these papers (the owner chose not to pay for more comparisons), and neither was any other threshold.
- **Each paper counts as a separate test.** No check for near-copies was made; each arXiv paper appears once.
- **Sending a paper to a person is not an error,** but it is work: here about one paper in five, plus one in four to sort by hand because it could not be processed.

### Repeating it

The engineering path is the same as for the news test ([Repeating it](accuracy-test-bbc-news.md#repeating-it)). You need a kit of files with an answer key, a deployed copy and a signed-in browser profile. The runner and its flags are in [scripts/live-accuracy/README.md](../scripts/live-accuracy/README.md). For a large run, `--max-batch-documents` sets the batch size up to the site's own per-run limit, and `--read-stall-min` sets how long reading may make no progress before the runner stops (default 10 minutes). Before a large run, measure reading on your own computer first ([the benchmark note](local-reading-benchmark.md)).

The scripts that built this kit are not in the repository, because they fetch and handle the papers. The method above (the classes, the licence filter, the seed and the rules) is enough to build a kit of the same kind. arXiv's holdings change, so it will not be the same papers.

### The category definitions

Exactly as used; none of the examples is text from the dataset.

| Category | What belongs | What does not |
|---|---|---|
| Computer vision | Research on how computers interpret and produce images and video: image classification, object detection and segmentation, 3D reconstruction from images, image and video generation, visual tracking, and medical image analysis. | Most easily confused with Neural and evolutionary computing. A paper whose main contribution is a learning method, network design or training rule studied for its own sake belongs there; a paper belongs here when its main problem is understanding or producing images or video, whatever method it uses. |
| Data structures and algorithms | Design and analysis of algorithms and data structures: running-time and memory bounds, approximation algorithms, graph algorithms, online and streaming algorithms, parameterized complexity and lower bounds. | Most easily confused with Programming languages. Work on how programs are written, typed, compiled or proved correct belongs there; a paper belongs here when its main result is an algorithm or data structure together with a bound on its cost. Theorems about the structure of groups belong in Group theory even when they mention computation. |
| Information theory | The mathematics of sending, storing and compressing information: channel capacity, error-correcting codes, limits of wireless and multi-antenna communication, rate-distortion, secrecy and entropy inequalities. | Most easily confused with Statistics theory. Estimation, hypothesis testing and the behaviour of statistical procedures belong there; a paper belongs here when its main question is how much information can be sent, stored or compressed, and with what codes. Steering or stabilising a dynamical system over a channel belongs in Systems and control when the control result is the main one. |
| Neural and evolutionary computing | Neural networks, spiking and brain-inspired models, evolutionary algorithms, genetic programming, and swarm and other nature-inspired optimisation methods, studied as methods of computing. | Most easily confused with Computer vision. A paper whose main problem is images or video belongs there even when it uses neural networks; a paper belongs here when its main contribution is the neural or evolutionary method itself. Mathematical guarantees about estimators and tests belong in Statistics theory. |
| Programming languages | Design, meaning and implementation of programming languages: type systems, semantics, compilers, program analysis and verification, domain-specific languages and language features. | Most easily confused with Data structures and algorithms. Results whose main object is an algorithm and its cost belong there; a paper belongs here when its main object is a language, its types or meaning, or tools that analyse, check or translate programs. |
| Systems and control | Control theory and the engineering of dynamical systems: feedback control design, stability analysis, state estimation, optimal and model predictive control, power grids, vehicle and robot control, and networked systems. | Most easily confused with Information theory. Limits on communication and coding belong there; a paper belongs here when its main question is how to steer, stabilise or estimate a dynamical system. Learning methods studied for their own sake belong in Neural and evolutionary computing. |
| Group theory | Pure mathematics of groups: finite groups, infinite and geometric group theory, group actions, representations of groups, presentations and word problems, and subgroup structure. | Most easily confused with Data structures and algorithms. A paper whose main result is an algorithm's running time belongs there even when its input is a group; a paper belongs here when its main results are theorems about groups. Theorems about estimators and tests belong in Statistics theory. |
| Statistics theory | Mathematical statistics: estimation, hypothesis testing, asymptotic theory, Bayesian inference, high-dimensional and nonparametric statistics, and the properties of statistical procedures. | Most easily confused with Information theory. Limits on sending, storing or compressing information belong there; a paper belongs here when its main results are properties of estimators, tests or other statistical procedures. |
| *None of these* | The document is not a research paper in computer vision, data structures and algorithms, information theory, neural and evolutionary computing, programming languages, systems and control, group theory or statistics theory. | |

Each category also had one generic example, in order: a method that finds and outlines every object in a photograph; an improved shortest-path algorithm with a proof of its running time; the highest reliable data rate over a noisy multi-antenna wireless channel; a new genetic algorithm for scheduling; a type system that rules out memory errors, with a soundness proof; a controller that keeps a power network stable under sudden demand changes; a classification of finite groups whose subgroups share a property; and how quickly an estimate of an unknown distribution approaches the truth.
