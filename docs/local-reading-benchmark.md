# How long reading takes on your computer: a benchmark note

**The short answer.** Doc Classifier reads your files on your own computer, in the browser, so how long reading takes depends on your computer, not on the site. On the owner's test computer, long research PDFs took between about 0.7 and 1.5 seconds each, and the same files took twice as long on one attempt as on another. Before a large run, time the reading of a sample of your own documents on the computer you will use, then plan with the formula at the end of this page. The figures here are measurements, not a promise.

---

## Why reading happens on your computer

Your original files never leave your computer ([DESIGN.md §4](../DESIGN.md#4-standing-rules), [DECISIONS 3](../DECISIONS.md#3-extraction-happens-in-the-browser-only-text-and-outline-go-to-the-cloud)). The browser opens each file in place, takes out its text and outline (headings and table headers), and only that text goes to the cloud. The cloud cannot read a file it never receives, so the reading speed is your computer's own:

- **Two files at a time.** The browser tab runs two background readers, and each reads one whole file at a time. The number is fixed at two; it does not change with how powerful the computer is.
- **Every file is read whole.** Every page or slide, every time. The design does not allow skipping or shortening anything to save time, because that could change an answer ([AGENTS.md](../AGENTS.md), "Never").
- **Nothing is sent while reading.** Sending starts only after you choose Start run.

What makes reading slower: long files, PDFs with many pages, formulas and complex layouts, a slower or busier computer, and other heavy work running at the same time.

## What was measured

All on 12 October 2026, on the owner's test computer (Windows 11, Microsoft Edge 155 driven headless by the accuracy test runner), with long research papers: PDFs a median 18 pages, about 58,000 characters of text each, plus some Word and PowerPoint files made from them. The details of that test are in [docs/accuracy-test-arxiv-papers.md](accuracy-test-arxiv-papers.md).

| Step | What was measured | Result |
|---|---|---|
| **Reading, batches of 60** | 18 batches, from the start of each batch until all 60 were read, including the runner putting the files into the browser first | 55 s to 2 min 40 s per batch (median 90 s): about 0.9 to 2.7 s per paper |
| **Reading, 1,079 papers in one go (third attempt)** | From the start of the batch until all 1,079 were read: 16 min 38 s, including putting the files into the browser. The reading screen itself took about 13 minutes. | About 0.7 s per paper on the reading screen |
| **Reading, the same 1,079 (second attempt, earlier the same morning)** | The reading screen's own clock: 801 of 1,079 read after 1,200 s, when the runner's deadline at the time stopped it | About 1.5 s per paper |
| **Sending the text, 1,079 papers** | From the run's creation until the last text was sent: about 22 minutes for about 67 million characters | About 0.8 papers a second (about 50,000 characters a second) |
| **Sending the text, batches of 60** | 16 batches | 1¼ to 4¼ minutes per batch (median 2 minutes) |
| **Processing, 1,065 papers** | From the end of sending until the run stopped on its daily allowance: about 9½ minutes, reader Claude Sonnet 5.5 | About 110 to 120 papers a minute |
| **Processing, batches of 60** | The 11 batches that finished, timed by status checks every 15 to 20 seconds | ½ to 1½ minutes per batch |

**The variance.** The same computer, the same files and the same order gave about 0.7 s per paper on one attempt and about 1.5 s on another, under an hour apart. The cause was not established. Other work running on the computer at the same time is the likely kind of cause, but it was not measured. Treat a single measurement as one sample, not as the speed of the machine.

**Sending and processing depend on other things.** Sending depends on your connection and how much text each file holds. Processing depends on the reader model, the AI services' own limits, and the site's limits: the owner's shared site takes at most 60 documents per run.

## Measure it yourself before a large run

Pick a sample of about 50 to 100 documents that look like your real collection: the same kinds of file, roughly the same lengths. Use the computer and browser (Chrome or Edge) you will use for the real run, with the same other programs open.

### (a) In the app: the Read files step

1. Start a new run and choose the sample folder.
2. While it reads, the Read files step shows how many are read ("38 of 114 read") and the time it started ("Still working · started 14:53:13 · 1200 s"). When it finishes it says "Read 114 files: all ready." with the time.
3. Seconds per file = (finish time − start time) ÷ number of files.
4. Nothing has been sent. You can leave the run unstarted; it stays under "New runs not started yet" on Home.

### (b) With the accuracy test runner

For engineers with their own deployment. Make a small kit (a `batch-01` folder of your sample and an `answer-key.json`; the format is in [scripts/live-accuracy/README.md](../scripts/live-accuracy/README.md)). Run `node scripts/live-accuracy/run.mjs` on it. The runner reads the folder through the real Read files screen, timing from the moment reading starts. It writes to the batch's `journal.jsonl`:

- a `reading` line every two minutes: `read`, `total`, `seconds` and `filesPerSecond`;
- an `extracted` line at the end: `files`, `seconds` and `filesPerSecond`.

The runner then goes on to send the batch, which costs money on a site with real AI services. Point it at the pretend-vendor installation ([docs/deployment.md](deployment.md), "Separate pretend-vendor installation") when only the reading speed is wanted. `--read-stall-min` (default 10) sets how many minutes reading may go without a newly read file before the runner stops. There is no fixed deadline, because reading time depends on the computer.

## Planning a large run

Measure your own rates as above, then:

> **total time ≈ N × r + N ÷ u + N ÷ p + a few minutes to confirm**
>
> N = number of documents; r = your measured reading seconds per document; u = documents sent per second; p = documents processed per second.

With the rates measured here for long research papers (r = 0.7 to 1.5 s, u ≈ 0.8 a second, p ≈ 2 a second), 1,000 papers come to about 12 to 25 minutes of reading, about 21 minutes of sending and about 8 to 9 minutes of processing: roughly 45 minutes to an hour in all. Shorter documents read and send in less time. A slower computer, a slower connection, other work on the machine, or a run that has to be split into batches because of a per-run limit all add time. Re-measure if any of them change.
