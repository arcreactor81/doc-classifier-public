# Does a lower-tier reader weaken the classifier?

A lower-tier reader can leave the full system competitive. It can also reduce useful automatic filings, increase processing failures, or replace some reviews with correct filings **and** misfiles. Model tier here is the owner's model-tier convention for Flash. Reader strength on a task is measured separately, using agreement with the published primary subject. All rates in this report are specific to these benchmarks.

## What can be paired

All 2,032 eligible November papers match an October original by SHA-256 and agree on its reference subject. October retained decisions for 1,797 of its 2,040 originals. Seven October decisions came from the eight papers later excluded. Thus 1,790 of the eligible November papers had October outcomes.

The 18 October plans agree exactly with the frozen November category definitions, examples and type identifiers, threshold of 0.90, reader output contract (`reader-exact-evidence-v2`) and confidence-question policy. The October confidence model was Jev 1.13.0. November used Jev 1.14.0 with long context. October's early batches used the whitespace quote policy, and its large run used the layout-aware policy also used in November. Routing and deployment differed during October. On every shared original with both outcomes, the saved upload hashes differed across eras. These hashes cover the serialized upload envelope, so this result does not establish which text, metadata, serialization or outline fields changed. Semantic equivalence of what the two readers saw is unverified.

**Direct same-upload comparisons** are available within November. The full Sol/Terra/Flash arms have 2,020 common outcomes and 1,998 common usable reader answers. Cohorts involving Luna end early. The two distinct Flash pilots share 60 identical uploads with each other and the pilot comparators. **Cross-era comparisons** below pair reference-labelled original files with two recorded decisions, and restrict reader comparisons to dual-usable answers. They describe the two system configurations as run, including selection into usable answers. They cannot isolate an intrinsic Claude-versus-November model effect.

## October Claude compared with November configurations

In paired columns the October Claude count comes first. Filing and review counts include recorded processing failures in the denominator. An automatic filing is correct when its destination matches the original published primary subject.

| November reader | Same original | Same upload | Correct filings | Wrong filings | Review | Failures | Both readers usable | Exact reader matches |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sol | 1,790 | 0 | 980 / 1,259 | 23 / 27 | 350 / 501 | 437 / 3 | 1,350 | 1,164 / 1,120 |
| Terra | 1,781 | 0 | 975 / 1,260 | 23 / 29 | 349 / 478 | 434 / 14 | 1,342 | 1,156 / 1,097 |
| Flash low (full run) | 1,790 | 0 | 980 / 1,271 | 23 / 28 | 350 / 486 | 437 / 5 | 1,349 | 1,163 / 1,084 |
| Luna | 103 | 0 | 53 / 53 | 0 / 0 | 23 / 33 | 27 / 17 | 64 | 55 / 50 |
| Flash off (pilot) | 52 | 0 | 23 / 26 | 0 / 0 | 16 / 22 | 13 / 4 | 36 | 30 / 27 |
| Flash low (pilot) | 52 | 0 | 23 / 31 | 0 / 0 | 16 / 20 | 13 / 1 | 38 | 31 / 29 |

On the 1,790 shared originals, the full Flash system had 291 more correct automatic filings, five more wrong filings, 136 more reviews and 432 fewer processing failures. On the 1,349 papers with usable reader answers in both eras, October Claude exactly matched 86.2% and November Flash 80.4%. A change in overall reader match and a change in automated filing yield can point in opposite directions. Most October failures in the larger October study occurred because the confidence judge could not process long papers.

The next table separates paired discordance from marginal totals. Holm adjustment here covers 36 exploratory cross-era comparisons (six arms by six binary events). Detailed counts for all tests, including total filing, review and failures, are in the accompanying statistics file. Paired tests of wrong filing use **all matched decisions**, because conditioning each arm on its own filings would create different denominators.

| November reader | Event | Pairs | October only / November only | Exact p | Holm p |
| --- | --- | --- | --- | --- | --- |
| Sol | Correct filing | 1,790 | 62 / 341 | 8.98e-48 | 2.69e-46 |
| Sol | Wrong filing | 1,790 | 10 / 14 | 0.541 | 1 |
| Sol | Reader exact | 1,350 | 94 / 50 | 0.000308 | 0.00677 |
| Terra | Correct filing | 1,781 | 57 / 342 | 1.23e-50 | 4.07e-49 |
| Terra | Wrong filing | 1,781 | 8 / 14 | 0.286 | 1 |
| Terra | Reader exact | 1,342 | 99 / 40 | 5.96e-07 | 1.37e-05 |
| Flash low (full run) | Correct filing | 1,790 | 67 / 358 | 4.03e-49 | 1.25e-47 |
| Flash low (full run) | Wrong filing | 1,790 | 10 / 15 | 0.424 | 1 |
| Flash low (full run) | Reader exact | 1,349 | 107 / 28 | 4.44e-12 | 1.06e-10 |
| Luna | Correct filing | 103 | 12 / 12 | 1 | 1 |
| Luna | Wrong filing | 103 | 0 / 0 | 1 | 1 |
| Luna | Reader exact | 64 | 7 / 2 | 0.18 | 1 |
| Flash off (pilot) | Correct filing | 52 | 6 / 9 | 0.607 | 1 |
| Flash off (pilot) | Wrong filing | 52 | 0 / 0 | 1 | 1 |
| Flash off (pilot) | Reader exact | 36 | 4 / 1 | 0.375 | 1 |
| Flash low (pilot) | Correct filing | 52 | 3 / 11 | 0.0574 | 1 |
| Flash low (pilot) | Wrong filing | 52 | 0 / 0 | 1 | 1 |
| Flash low (pilot) | Reader exact | 38 | 3 / 1 | 0.625 | 1 |

## Identical November inputs

The next tables keep exactly the same documents and available answers for every reader in each row. This restriction is necessary for comparing model ordering. For example, the full-study Sol–Flash comparison using just those two readers has 2,024 usable pairs. Additionally requiring Terra to have a usable answer leaves 1,998. Each November arm independently reran Jev; product outcomes therefore describe reader configurations in combination with the rest of the pipeline.

### Full-size reader configurations

| Group | Stratum | Outcomes for all | Usable for all | Sol exact | Terra exact | Flash low (full run) exact |
| --- | --- | --- | --- | --- | --- | --- |
| Overall | All documents | 2020 | 1998 | 1659 | 1642 | 1630 |
| Subject | algorithms | 252 | 250 | 235 | 239 | 244 |
| Subject | computer vision | 253 | 251 | 222 | 204 | 187 |
| Subject | group theory | 254 | 251 | 234 | 224 | 219 |
| Subject | information theory | 254 | 252 | 145 | 143 | 139 |
| Subject | neural evolutionary | 253 | 251 | 197 | 210 | 226 |
| Subject | programming languages | 251 | 247 | 224 | 220 | 209 |
| Subject | statistics theory | 253 | 252 | 227 | 222 | 231 |
| Subject | systems control | 250 | 244 | 175 | 180 | 175 |
| Format | docx | 247 | 244 | 198 | 200 | 204 |
| Format | pdf | 1653 | 1635 | 1359 | 1339 | 1331 |
| Format | pptx | 120 | 119 | 102 | 103 | 95 |

### Luna overlap

| Group | Stratum | Outcomes for all | Usable for all | Sol exact | Terra exact | Luna exact | Flash low (full run) exact |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Overall | All documents | 117 | 93 | 78 | 79 | 68 | 78 |
| Subject | algorithms | 15 | 10 | 9 | 9 | 10 | 10 |
| Subject | computer vision | 18 | 15 | 14 | 14 | 11 | 12 |
| Subject | group theory | 16 | 15 | 15 | 14 | 12 | 15 |
| Subject | information theory | 15 | 12 | 7 | 7 | 4 | 6 |
| Subject | neural evolutionary | 13 | 9 | 6 | 8 | 4 | 7 |
| Subject | programming languages | 12 | 10 | 9 | 9 | 10 | 10 |
| Subject | statistics theory | 14 | 9 | 8 | 7 | 7 | 8 |
| Subject | systems control | 14 | 13 | 10 | 11 | 10 | 10 |
| Format | docx | 12 | 10 | 9 | 9 | 8 | 8 |
| Format | pdf | 99 | 80 | 67 | 67 | 58 | 67 |
| Format | pptx | 6 | 3 | 2 | 3 | 2 | 3 |

### Five-reader pilot overlap

| Group | Stratum | Outcomes for all | Usable for all | Sol exact | Terra exact | Luna exact | Flash off (pilot) exact | Flash low (pilot) exact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Overall | All documents | 60 | 44 | 35 | 36 | 29 | 35 | 32 |
| Subject | algorithms | 8 | 4 | 3 | 3 | 4 | 4 | 4 |
| Subject | computer vision | 8 | 4 | 4 | 4 | 3 | 3 | 2 |
| Subject | group theory | 8 | 8 | 8 | 8 | 6 | 8 | 8 |
| Subject | information theory | 8 | 6 | 3 | 3 | 2 | 3 | 3 |
| Subject | neural evolutionary | 7 | 6 | 4 | 5 | 2 | 4 | 2 |
| Subject | programming languages | 7 | 5 | 5 | 5 | 5 | 5 | 5 |
| Subject | statistics theory | 7 | 4 | 4 | 3 | 3 | 4 | 4 |
| Subject | systems control | 7 | 7 | 4 | 5 | 4 | 4 | 4 |
| Format | docx | 7 | 5 | 4 | 4 | 4 | 4 | 4 |
| Format | pdf | 52 | 38 | 31 | 31 | 25 | 31 | 28 |
| Format | pptx | 1 | 1 | 0 | 1 | 0 | 0 | 0 |

On the 1,998 papers usable by all three full-size readers, Sol led in aggregate (83.0%), followed by Terra (82.2%) and Flash (81.6%). None of the three paired comparisons reached 0.05 before adjustment. The ranking reversed across subjects. In computer vision Sol had 222 exact results and Flash 187 among 251 papers. In neural/evolutionary computing Flash had 226 and Sol 197 among 251. Both differences survived Holm correction across 33 within-stratum contrasts (three reader pairs across eight subjects and three formats). For all three readers, exact matches were much less frequent in information theory than in programming languages, despite similar numbers of papers.

Conditional randomization also detected variation by subject for every reader pair. It tests whether the **direction of reader disagreement** varies among strata, conditioning on the discordant totals and the total in each direction. It cannot establish a causal effect of subject or file format. Document-format groups were unbalanced and the Office documents were converted from PDFs.

| Grouping and reader pair | Discordant | Conditional randomization p | Holm p (six tests) |
| --- | --- | --- | --- |
| byCategory sol vs terra | 99 | 5e-06 | 3e-05 |
| byCategory sol vs flash_full | 227 | 5e-06 | 3e-05 |
| byCategory terra vs flash_full | 176 | 1e-05 | 4e-05 |
| byFormat sol vs terra | 99 | 0.3 | 0.3 |
| byFormat sol vs flash_full | 227 | 0.0982 | 0.234 |
| byFormat terra vs flash_full | 176 | 0.0779 | 0.234 |

## Other recorded readers

The BBC corpus has a direct paired Claude–GPT-5.4 mini comparison on 941 common articles. Claude had 880 exact reader matches and mini 810, treating absent answers as unsuccessful. Claude correctly filed 801 articles and mini 747. Wrong filings were 11 and six. Mini sent 30 more to review and had 29 more failures. That gives concrete support to the claim about weaker standalone reading without a demonstrated increase in wrong filings; it also shows why “just a bigger review queue” would miss a practical cost.

The September five-document comparison tested an earlier Sol against GPT-5.6 Terra and reported identical positive category sets on all five. The early 85-document Sol run lacks a comparable filing denominator. The October 20-document GPT-5.4 live check used generated examples. The Jev/Liquid bake-off exercised the confidence role without a reader. The two-document Luna comparison was heading recovery. No matched Qwen or Clef reader outcome cohort appears in the retained experiment inventory. These studies do not supply additional head-to-head rankings on the research-paper cohort.

## Reproducibility and interpretation

The offline extraction checked reference agreement, unique document identities, upload hashes within November, the per-run taxonomy and October outcome totals. October reader accuracy is the singleton positive matching the reference. A missing reader answer is kept missing; an observed zero- or multi-category answer is a non-match. Source artifacts stay local. Only aggregate counts are emitted.

The [aggregate inputs](data/reader-strength-inputs.json) give the matched counts. The [94 statistical checks](data/reader-strength-tests.json) give raw and Holm-adjusted values. Exact paired McNemar tests condition on the number of discordant pairs, using equal probabilities and two tails. Other exploratory families are the 19 common-cohort reader contrasts and the 33 within-stratum reader contrasts. Conditional randomization uses 200,000 draws per comparison, seed 20261118 and the Monte Carlo plus-one correction. The smallest attainable p-value is about 0.000005. Families were grouped after data collection. The reference labels come from paper authors, the selected documents can be related, and complete-case selection can favor easy-to-process papers. No client labels, independent replication, equivalence margin or causal model-tier effect is supplied by these comparisons.

[Browse all experiments](results.md)

[Download the document-level dataset and retrieve the benchmark sources](../datasets/reader-benchmarks/README.md)
