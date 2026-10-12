# Accuracy test: 941 BBC News articles on the live site (11 October 2026)

**The short answer.** We put 941 real news articles through the owner's live site, with no training and no tuning. It filed 812 of them (86%) on its own; 801 went to the right folder and 11 to the wrong one. It sent 128 (14%) to a person and could not process one. Statistically, that means **fewer than 2.24% of the documents it files on its own go to the wrong folder, with 95% confidence.** It cost about one US cent per article.

The same evening the same articles went through again with a second, cheaper reader, **GPT-5.4 mini**, on OpenAI's free allowance. Mini is clearly the weaker reader on its own, yet behind the two-judge rule it misfiled no more (6 against 11). It sent more to a person instead, 17% against 14%. See [A second reader: GPT-5.4 mini](#a-second-reader-gpt-54-mini).

![What happened to 941 BBC News articles: 801 filed in the right folder, 11 in the wrong one, 128 sent to a person, 1 could not be processed. Below, wrong answers among the articles each approach would file: the reader alone 6.4% (60 of 940), Jev alone at certainty 0.90 or more 2.3% (19 of 826), and the product's rule, both judges agreeing with certainty 0.90 or more, 1.35% (11 of 812), 95% range 0.67% to 2.42%.](images/bbc-accuracy.svg)

*Top: every article's outcome. Bottom: the same articles and the same answers, with three different rules for when to file. Requiring both judges to agree is what brings the error down.*

This page is written for two readers. The first half says what was tested and what the numbers mean, in plain words. [How the test was run](#how-the-test-was-run) and the sections after it give the method, the statistics and how to repeat it.

---

## The results

| | Articles | Share |
|---|---|---|
| Filed automatically | 812 | 86.3% of all |
| … in the right folder | 801 | 98.65% of those filed |
| … in the wrong folder (a **misfile**) | 11 | 1.35% of those filed |
| Sent to a person (**needs review**) | 128 | 13.6% of all |
| Could not process | 1 | 0.1% of all |
| **Total** | **941** | |

**How sure we can be.** Any test on a sample has some luck in it: test a different 941 articles and you would get slightly different numbers. A *95% range* is the band that the true rate falls in, 95 times out of 100, given what we saw.

- **Misfile rate:** 1.35%, 95% range **0.67% to 2.42%**. Put as a guarantee: the misfile rate is **below 2.24%**, with 95% confidence.
- **Review rate:** 13.6%, 95% range 11.5% to 16.0%. This is the share of articles left for a person. It measures work, not mistakes: an article sent to a person has not been filed wrongly.

## Why two judges, and what they bought

Every article is judged twice, by two systems that work differently (see [Two judges, not one](../README.md#-two-judges-not-one) in the README):

- **Jev** (TypeSafe's model, version 1.13.0) picks one category and says how certain it is.
- **The reader** (here Claude Sonnet 5.5, made by Anthropic) reads the whole article and says yes or no for each category, quoting the article to back each yes.

A fixed rule in code files an article only when both name the same single category **and** Jev's certainty is at least 0.90. Everything else goes to a person. No AI model makes the final decision.

What each part would have done on its own, on the same articles:

| Approach | Files | Wrong among those | Notes |
|---|---|---|---|
| The reader alone | every article (940 with an answer) | 60 (6.4%) | Its 60 include answers that named no category, or more than one. |
| Jev alone, every article | 941 | 49 (5.2%) | Jev's top choice was right on 892. |
| Jev alone, only when certainty ≥ 0.90 | 826 | 19 (2.3%) | |
| Both agree, any certainty | 881 | 13 (1.5%) | |
| **Both agree and certainty ≥ 0.90 (the product)** | **812** | **11 (1.35%)** | |

So each judge alone was right about 94% of the time. Compare Jev alone at the same 0.90 threshold with the product's rule: the reader's agreement held back 14 more articles, and 8 of those 14 were Jev's confident mistakes. Of the 19 articles Jev was sure about and got wrong, 8 went to a person instead of the wrong folder. The price is the review pile: one article in seven waits for a person.

## Where the mistakes were

| Category | Articles | Filed right | Filed wrong | Sent to a person |
|---|---|---|---|---|
| Business | 185 | 143 | 6 | 36 |
| Entertainment | 188 | 164 | 1 | 23 |
| Politics | 192 | 175 | 0 | 17 |
| Sport | 191 | 190 | 0 | 1 |
| Technology | 185 | 129 | 4 | 51 (and 1 could not process) |

The 11 misfiles, by the folder they went to and the answer key's label:

- 6 articles labelled *Business* filed in *Politics*;
- 2 labelled *Technology* filed in *Business*;
- 1 labelled *Technology* filed in *Politics*;
- 1 labelled *Technology* filed in *Entertainment*;
- 1 labelled *Entertainment* filed in *Business*.

They cluster where the categories overlap in real news: the economy as a political subject, and the business side of technology and media. Sport, the most clearly bounded category, had no misfile and almost nothing for review. The 11 were not re-examined: the answer key is taken as right, so any of them could equally be a debatable label.

Every misfile had Jev certainty of 0.93 or more, and both judges named the same wrong category. That is the failure mode two judges cannot catch: both confidently wrong in the same way.

## What went to a person, and why

Every review carries the rule that sent it (the rule table is in the README and [DESIGN.md §5.6](../DESIGN.md#56-decide)):

| Rule | Why it went to a person | Articles | Of those, what the answer key says |
|---|---|---|---|
| R2 | Both judges agreed, but Jev's certainty was below 0.90 | 45 | 44 of the 45 agreed answers were right |
| R3 | The reader said the article fits two or more categories | 41 | The right category was among the reader's yeses in 39 |
| R5 | The two judges did not agree (or agreed with a weak score from Jev for that category) | 40 | The reader's answer matched the key in 35, Jev's top choice in 27; both can match |
| R4 | Both judges said it fits no category | 2 | Both had a category in the answer key |

R2 shows what the 0.90 threshold costs: 44 of those 45 articles would have been filed correctly. That is the threshold doing its job, not a reason to lower it from one test: the product never changes a threshold automatically, and a person decides from their own corrected runs ([DESIGN.md §10](../DESIGN.md#10-bake-off)).

## The one that could not be processed

The reader's answer for one technology article did not match the required answer format, so the system did not use it and set the article aside as *could not process*, with that reason. It did not guess. A person can include it in a new run.

## A second reader: GPT-5.4 mini

The same evening (11 October, 17:38–18:50 UTC) the same 1,000 articles went through the live site again. Everything was the same except the reader: **GPT-5.4 mini**, OpenAI's smaller model, which runs on the owner's free daily allowance. The comparison below uses the 941 articles both runs scored, article by article.

| | Claude Sonnet 5.5 | GPT-5.4 mini |
|---|---|---|
| Filed automatically | 812 (86.3%) | 753 (80.0%) |
| … in the wrong folder | 11 (1.35%; 95% range 0.67%–2.42%) | **6 (0.80%; 95% range 0.29%–1.73%)** |
| Sent to a person | 128 (13.6%) | 158 (16.8%) |
| Could not process | 1 | **30** |
| The reader alone named exactly the right category | **880 of 941 (93.5%)** | 810 of 941 (86.1%; its 30 refused answers count as not right) |
| Cost per article at list price | USD 0.0102 | USD 0.0044, and **USD 0 in fact**: it ran inside the free allowance |

Across all 1,000 articles (mini's run also completed batch 9), mini filed 800 with 7 wrong: 0.88%, below 1.64% with 95% confidence.

What it shows:

- **As a reader on its own, Claude is clearly better.** On the same articles, Claude alone was right on 83 that mini got wrong, and mini on 13 the other way. That gap is not luck (see the tests below).
- **Behind the two-judge rule, mini is at least as safe.** It misfiled 6 articles to Claude's 11; 6 were misfiled by both. Mini's lower rate is not proven better (p = 0.06), but it is certainly not worse. Its mistakes were the same kind: 3 economy stories filed under Politics, 2 technology stories under Business, 1 under Politics.
- **The price of the cheaper reader is review work.** Mini's weaker answers did not become misfiles; the rule sent them to a person. About one article in five waited for a person instead of one in seven. Most went because mini said an article fitted two categories (82, against Claude's 41).
- **The 30 it could not process.** In every one of the 30, mini's quotes from the article were not word for word, so the system refused the answer instead of trusting it, as designed. Claude had 1 such failure in 941. A person can include the 30 in a new run.
- **It used the free allowance.** 1,000 articles took about 2.4 million tokens. To fit them into one evening, the site's daily cap for the small models was raised from 2.25 to 2.5 million for the last two batches, OpenAI's own free limit, then put back (DECISIONS 156, addenda of 11 and 12 October 2026).

In one line: the cheaper reader stays safe behind Jev, and what it costs is a bigger pile for a person, not more misfiled documents.

**Why only these two readers.** The owner decided not to pay for more comparisons without a reason ("if someone wants to run comparisons they can pay for it"; DECISIONS 156, addendum of 11 October 2026). Claude was paid from a USD 100 credit Anthropic gave the owner, and mini ran free. Not run: the site's default reader, full GPT-5.4 (free, but about sixteen days at its daily allowance), and the GPT-6 and GPT-5.6 families (paid). Anyone can run another reader on the same articles with the tools under [Repeating it](#repeating-it), at their own cost; the scoring tool pairs the runs article by article.

## Cost and time

- **About USD 0.0102 per article**, USD 9.63 for the 941 scored articles; about USD 9.66 with the stopped batch and the retry described below. Almost all of it was the reader (Claude Sonnet 5.5, USD 2 per million input tokens and USD 10 per million output); Jev cost USD 0.14 in all.
- **About 2½ minutes per batch of 59** (median 2 min 33 s; shortest 2 min 11 s, longest 6 min 53 s), measured by the test runner from its check before each batch to its check after the batch's last decision, so including launching the browser and loading the files into it. From confirming the upload to the last decision alone, a batch took 1 min 53 s to 2 min 55 s (median 2 min 8 s). The later batches ran while other heavy work shared the test computer, and the runner waited for free memory between batches; the longest batch spent most of its extra time before the upload began.

## One stop, and what changed because of it

The ninth batch stopped. Anthropic's network refused one request before it reached the model (a "403 Request not allowed", with none of the replies the AI service itself sends). The site wrongly reported it as a rejected key. The same article went through when retried on its own.

That batch is left out of the score, because its run stopped part-way. The owner then decided how such a refusal is handled from now on ([DECISIONS 156](../DECISIONS.md#156-a-claude-reader-claude-sonnet-55-for-the-accuracy-test-paid-from-a-usd-100-anthropic-credit), addendum of 11 October 2026):

- Only that document fails, with a plain reason ("the AI service's network turned this request away before it reached the model; your key was not the problem").
- It counts as no charge, because the request never reached the model.
- It is never retried automatically, and a person can re-run it.
- If it happens to three documents in a row, the run still stops loudly.
- The test runner, when it stops, now says why and prints the exact command to continue.

This went live the same evening, after the test.

## How it compares with published results

The BBC News set has been a standard test since 2006, so there are published scores to set this against. They answer a slightly different question, so here is what compares with what. All sources were read on 11 October 2026.

| Kind of system | Trained on BBC labels? | Best published result found | Source |
|---|---|---|---|
| Classic statistics (word counts + Naive Bayes) | yes | 95.7% of 445 test articles | Wagh et al. 2021, [arXiv 2111.00702](https://arxiv.org/abs/2111.00702) |
| Fine-tuned BERT, a language model trained on the labels | yes | 98.2% of the same 445 | Wagh et al. 2021 |
| A small fine-tuned Llama model | yes | 97.9% of 1,000 test articles | Maheshwari and Raina 2026, [arXiv 2601.03450](https://arxiv.org/abs/2601.03450) |
| **No training** (zero-shot): best found | no | 89.5% of all 2,225 | Fei et al. 2022 ("SimPTC"), [arXiv 2210.16637](https://arxiv.org/abs/2210.16637) |
| No training: plain prompting of a language model | no | 75.8% of all 2,225 | the same paper |
| No training: the standard zero-shot tool (BART-MNLI) | no | 71.1% of all 2,225 | Harrando and Troncy 2021, [LDK 2021](https://drops.dagstuhl.de/opus/volltexte/2021/14553/) |
| **This test: Jev alone, every article** | **no** | **94.8% of 941** | |
| **This test: the reader alone, every article** | **no** | **93.6% of 940** | |
| **This test: the product, on the 86% it filed** | **no** | **98.65% of 812** | |

What this means:

- **Against other no-training systems, the fair comparison:** each of our judges alone did better than every published no-training result found. The best of those was 89.5%; ours were 94.8% and 93.6%, and the gap is statistically clear (see the tests below). The published systems used older and smaller models, so this mostly shows how far current models have come; it is not a contest between methods.
- **Against systems trained on the labels:** on the documents it files, the product is in the same range as the best trained systems (98.65% against 98.2% for BERT). The difference is not statistically meaningful, so the honest claim is "the same range", not "better". And it is not like for like: those systems answer every article, while ours answered 86% and handed the rest to a person. Trained systems need thousands of labelled examples first; ours had five short descriptions.
- **Nothing published does what the product does.** No published BBC result found sends uncertain articles to a person, so there is no direct comparison for "98.65% right while filing 86%". Nor was any published result found for current frontier models such as Claude or GPT-5 on this set.

Three cautions apply to every row. The samples differ: ours is 941 articles, 200 per category before one batch was dropped, with the 100 repeated articles in the original 2,225 removed; the published scores use the full set or fixed splits that still contain them. The labels are the BBC's own filing choices, and nobody has measured how often independent people would disagree with them. And the set has been public since 2006, so any language model, ours or the published ones, may have seen these articles while it was being built.

---

## How the test was run

**The articles.** The BBC News dataset: 2,225 articles from the BBC News website, 2004–2005, each labelled with one of five categories (98 of the 2,225 are byte-for-byte repeats of another article; 100 are repeats once differences in spacing are ignored). It was published by D. Greene and P. Cunningham, "Practical Solutions to the Problem of Diagonal Dominance in Kernel Document Clustering", *Proc. ICML 2006*, and is distributed by the Machine Learning Group at University College Dublin "for non-commercial and research purposes only". Copyright in the articles is the BBC's. The 100 repeats were removed first, comparing text with spacing ignored. Then 200 articles per category were drawn with a fixed random seed (20261010), 1,000 in all, and shuffled together, so an article's number says nothing about its category.

**The files.** Each article became a Word file with its headline as a heading and its paragraphs as body text. The files were built on the owner's computer and uploaded through the site in the browser like any user's files: only text and outline left the machine. No article text is in this repository, and none will be: only the scores are published.

**The categories.** Five categories written in plain language before the test, each with what belongs, what does not and why, and one generic example (listed [below](#the-category-definitions)). They were not changed during the test. No model saw the answer key. The site was never told the labels; the scoring tool compared its outcomes to the key afterwards.

**The settings.** The owner's live site, build `b766f90`:

- Reader: Claude Sonnet 5.5, requested by name. Every reply reported `claude-sonnet-5-5`, served from Anthropic's global region, through Cloudflare's AI Gateway with caching off. Reader effort was low, with an output cap of 16,384 tokens.
- Certainty judge: TypeSafe Jev 1.13.0.
- Threshold: 0.90. That is the starting value for a new project ("untested"), not one tuned on these articles.
- Batches of up to 59 articles, the site's per-run limit. The pilot step, a short check run before a large run, was skipped and labelled as skipped (DECISIONS 88), since every batch was scored in full.

**The batches.** For Claude, 17 batches: 1–8 in the morning of 11 October (UTC), 9 stopped (see above), 10–17 in the afternoon. That is 16 completed runs and 941 scored articles. For mini, all 17 batches completed the same evening on builds `f392ec3` (batches 1–15) and `3e61237` (16–17, the raised daily cap; nothing else changed), with the same category text saved as a new revision.

**The scoring.** Each article's outcome is the one its run recorded. A filed article is right when its folder matches the answer key. The tools are `scripts/live-accuracy/` (runner, guard, scoring and report) and `scripts/live-bakeoff/score.mjs`.

### The statistics

All at 95% confidence:

- **Misfile rate.** The range is the Clopper–Pearson exact interval, 0.67%–2.42%. The Wilson score interval gives 0.75%–2.41%.
- **"Below 2.24%".** This is the one-sided Clopper–Pearson upper bound.
- **Review rate.** The range is the Wilson score interval.
- **Each judge alone, all documents.** Using the Wilson interval:

  | Judge | Right | Accuracy | 95% range |
  |---|---|---|---|
  | Reader | 880 of 940 | 93.6% | 91.9%–95.0% |
  | Jev | 892 of 941 | 94.8% | 93.2%–96.0% |

- **How many documents a stronger claim takes.** To show the misfile rate is below a target, you need at least n filed documents with labels, where with no misfile n ≥ ln(0.05) / ln(1 − target):

  | Target | Filed documents needed, with no misfile | Filed documents needed, with one misfile |
  |---|---|---|
  | Below 1% | 299 | 473 |
  | Below 0.5% | 598 | 947 |
  | Below 0.1% | 2,995 | 4,742 |

### Significance tests

A significance test asks: could this difference be luck? The *p-value* is the chance of seeing a difference at least this big if there were really none. Below 0.05 is the usual line for "not luck". These were run on the recorded outcomes, with no change to any of them.

| Question | Test | Result | Verdict |
|---|---|---|---|
| Does the reader's veto pick out Jev's mistakes, or hold articles back at random? Of the 826 articles Jev was sure about, the reader held back 14, and 8 of those 14 were among Jev's 19 mistakes. | Hypergeometric test, one-sided | p = 4 × 10⁻¹¹ | **Not luck.** Picking 14 at random would almost never catch 8 of 19 mistakes. |
| Is Jev alone (892 of 941 right) better than the reader alone (880 of 940)? Same articles, paired. | McNemar's exact test: Jev alone right on 23, the reader alone on 12 | p = 0.09 | **Not shown.** The two judges are about equally good alone. |
| Are our single judges better than the best published no-training result (89.5% of 2,225)? | Two-proportion z-test | Jev p = 2 × 10⁻⁶; reader p = 0.0003 | **Yes.** It is a clear gap, with the cautions above. |
| Is the product's 98.65% on filed articles different from BERT's 98.2% (437 of 445)? | Fisher's exact test | p = 0.63 | **No difference shown.** It is the same range. |
| Are misfiles spread evenly over the 16 batches (0 to 2 each)? | Chi-square, by permutation | p = 0.60 | **Yes, even.** No batch, morning or afternoon stands out (morning 4, afternoon 7; Fisher p = 0.55). |
| Are Business articles misfiled more than Sport (6 of 149 against 0 of 190)? | Fisher's exact test | p = 0.007 | **Yes.** The errors sit where the categories overlap. |
| Is Claude a better reader than GPT-5.4 mini on its own? Same 941 articles: Claude alone right on 83, mini alone on 13. | McNemar's exact test | p = 1 × 10⁻¹³ | **Yes, clearly.** |
| Does the product file more articles right with Claude than with mini? Claude alone filed right 60, mini alone 6. | McNemar's exact test | p = 3 × 10⁻¹² | **Yes.** Mini sends more to a person. |
| Does mini misfile less than Claude? Claude alone misfiled 5, mini alone 0 (6 by both). | McNemar's exact test | p = 0.06 | **Not shown.** Mini is at least as safe; "safer" is not proven. |

Read these with care:

- **Ten p-values, not one.** With a strict correction for running several tests (Bonferroni: 0.05 ÷ 10 = 0.005), every "yes" above still holds except Business against Sport (0.0068), which then only suggests a difference.
- **A test against a published number assumes both samples are fair draws of the same kind of article.** It can tell luck from a real gap, but it cannot fix the differences in sample, labels and setup listed above.
- **What a significance test cannot do here.** It can't say whether our 1.35% would hold on your documents. That needs your documents.
- **The comparison not run:** the default GPT-5.4 reader on the same articles, by the owner's decision above. The scoring tool pairs any two runs article by article with McNemar's test, the right test for "is reader A better than reader B on the same documents".

### What these numbers do not prove

- **They describe news articles in five broad categories.** Your documents, categories and wording may do better or worse. Real filing schemes often have more categories and finer lines between them. The way to know is to run your own documents and correct the results; the corrected run becomes your test set.
- **They take the answer key as right.** Some BBC labels are debatable, especially between Business, Politics and Technology. A wrong label shows up here as a misfile, or hides one.
- **Two readers, one threshold, one day.** The owner's default reader, full GPT-5.4, was not measured, and neither was any other threshold than the starting 0.90.
- **Each article counts as a separate test.** Near-copies of the same story would make the ranges look narrower than they are. Repeated articles were removed; near-copies were not (an independent check found 56 pairs of the 2,127 sharing nine-tenths of their wording, none across categories).
- **Sending an article to a person is not an error,** but it is work: here, about one article in seven.

### Repeating it

The engineering path: you need the dataset, a deployed copy and a signed-in browser profile.

1. Build a kit of Word files with an answer key. The kit format and every runner flag are in [scripts/live-accuracy/README.md](../scripts/live-accuracy/README.md).
2. Switch the categories with `node scripts/live-accuracy/categories.mjs` (dry run, then `--apply`).
3. Run `node scripts/live-accuracy/run.mjs` once with `--preflight-only`, then again without it.
4. Produce the report with `node scripts/live-accuracy/report.mjs <final score JSON>`.
5. Restore your categories with `categories.mjs restore`.

The runner refuses to start if anything it checks is wrong. It stops on any unexpected write or page error, and when it stops it prints why and the exact command to continue.

### The category definitions

Exactly as used; none of the examples is text from the dataset.

| Category | What belongs | What does not |
|---|---|---|
| Business | News about companies, markets and the economy: company results, takeovers and mergers, share prices, interest rates, inflation, trade, jobs figures and economic growth. | Most easily confused with Politics. A story about what the government, ministers or parties propose, decide or argue over belongs in Politics even when the subject is the economy; it belongs here when its main subject is a company, a market or economic figures. The money side of a technology or media company (profits, sales, deals) belongs here; its products belong in Technology or Entertainment. |
| Entertainment | News about film, television, music, theatre, books and the people who make them: releases, box-office figures, charts, awards, reviews, festivals and performers' careers. | Most easily confused with Business. A story about a media or music company's profits, sales or deals belongs in Business; it belongs here when its main subject is a work, a performer, a show or an award. Athletes and sporting events belong in Sport, even when famous. |
| Politics | News about government, parliament, political parties and elections: policies, proposed laws, ministers, election campaigns, votes, opinion polls and public inquiries. | Most easily confused with Business. Economic figures and company news belong in Business; a story belongs here when its main subject is what the government, parliament or the parties propose, decide or dispute. |
| Sport | News about sports, athletes, teams and competitions: match reports, results, player transfers, injuries, tournaments, coaches and sports governing bodies. | Most easily confused with Entertainment. Film, music and television stars and their shows belong in Entertainment; a story belongs here when its main subject is a sport, a competition or an athlete's sporting career. |
| Technology | News about technology and the internet: computers, mobile phones, software, video games, online services, gadgets, computer security and digital rights. | Most easily confused with Business. A technology company's profits, share price or takeover deals belong in Business; a story belongs here when its main subject is the technology itself or how people use it. |
| *None of these* | The document is not a news story about business, entertainment, politics, sport or technology. | |

Each category also had one generic example, in order: a large company's yearly profits and share price; the winners of a national film awards ceremony; a parliamentary vote on a proposed new law; a football match report with the score; a new mobile phone and its features.
