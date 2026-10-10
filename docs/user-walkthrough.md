# Use the document classifier

Open the owner's website in desktop Chrome or Edge and sign in. You do not need to install an app or deploy your own copy. Your administrator sets up access; authorized editors manage the document categories.

This guide describes the flow of the owner's live site as of 10 October 2026: the "Sorting Room" design, the reader menu (the OpenAI readers are asked for by name, and Results say when a reader's version differs from the previous run), the daily allowances and stopping a run. The screen names below are the ones the site shows.

## 1. Choose your documents

On **Home**, select **Start a new run**, choose the folder of originals and allow the browser to read it. Supported formats are PDF, Word (.docx), and PowerPoint (.pptx). Older .doc/.ppt files and scanned PDFs without a text layer cannot be processed.

Wait for local extraction to finish. Review any failures shown. Original files stay on your machine; choosing a folder does not upload them. Keep the originals for building your result folders later.

## 2. Choose the reader, check the limits and start

Every new run uses **Interactive** mode. Results appear as documents complete.

For a collection larger than the configured trial size (currently 25), the recommended path starts with a **Small trial**. The initial selection is the first documents in the original selection order; inspect and change that selection before confirming. Alternatively, explicitly choose **Use all documents without a trial**. That choice is saved and shown on the run; it only prepares the selection, and Start still requires spending confirmation. You can return to the trial path before starting. A smaller collection can be an ordinary small run, or you can explicitly choose a trial, even for one document. The rest of the collection stays available locally.

Under **Reader model**, choose the model that reads every selected document. On the owner's site the menu offers GPT-5.4 (the default) and GPT-5.4 mini, and two readers marked **Experimental**: Qwen 3.8 27B (Cloudflare) and DeepSeek Flash. Beside each option a line says who processes the text and whether it may be used for training, and every confirmation says the text also goes to TypeSafe for the confidence check: use sample documents only on a shared site. Beside DeepSeek, the page says whether DeepSeek's full or half (off-peak) price applies now; the site counts every DeepSeek call at the full price either way. A reader the site cannot use is greyed out with its reason, and a full run after a trial offers only the trial's reader. The choice is recorded with the run. Each reader keeps its own track record, so a reader you have not used on these categories starts at 90% certainty, untested.

On a shared site, **Daily allowance** shows the site's limits: the most documents per run (60 on the owner's site), how many runs you have started today out of the limit (3; a trial and its first full run count as one; a category editor or a trusted user the owner names has no daily caps, and reads **This account has no daily caps on runs, price checks, saved reviews or saves of confirmed labels.** instead), and each shared allowance with its usage. Where enough documents have been measured, it estimates how many more documents fit today; otherwise it says **Not measured yet**. The allowances are shared by every visitor, so other runs can use them while the page is open, and they reset at 00:00 UTC (shown in your local time). While other runs hold an allowance, your documents wait and ask again; if the day's allowance runs out, the run stops with a plain reason and never switches to another reader.

Under **Spending limit**, enter a USD limit; **More spending options** offers separate limits for each system or the explicit no-limit choice:

- The main limit covers the combined recorded model spending.
- **Stop if OpenAI spending reaches** and **Stop if TypeSafe spending reaches** set separate limits. With Qwen or DeepSeek as the reader, the first is named after both services paid for reading ("Stop if Cloudflare and OpenAI spending reaches", or DeepSeek and OpenAI), because heading recovery stays on OpenAI.
- A blank separate-limit field has no separate limit. Leaving every field blank does not authorize unlimited spending.

To run without limits, explicitly select that option and acknowledge its warning. Recorded limits stop new requests, but already submitted work can still add charges. The site's daily allowances apply as well as your own limit.

Check the selected documents, categories and spending choice, then select **Start run**. If those details change, review them again before starting. Text and structure are uploaded only after confirmation; originals are never uploaded. Preparation and upload progress appear while this action is working.

If the buttons are unavailable, open **System** and share its listed setup issue with your administrator. An unavailable duration estimate is not a prediction that the run cannot finish.

## 3. Read the results

Open **Runs** and select your run. The page shows completed-document counts and recorded spending. A provider-requested pause is shown when one is active.

- **Filed**: the rules accepted the agreement for that type.
- **Needs review**: a person needs to decide. **Review first** marks disagreements given priority.
- **Could not process**: read the recorded reason. A completed run can contain failures; completion does not mean every document was filed.

Select **Open** beside a document to see the saved opinions and reader quotes as returned. Missing validated output is shown explicitly. Evidence does not download a results file or close the run.

Only the site owner (a listed category editor) can stop all runs, with **Stop all runs…** on **System**, and only a category editor can allow new runs again. That stop applies to every run on the site, not just the one on screen. Everyone else sees "Only the site owner can stop all runs. You can stop your own run by discarding it."

To stop your own run, select **Discard this run…** on its Progress screen and confirm **Discard the run**. The run stops now, its uploaded text is deleted, and it will never have a results file. Your original files stay on your computer. Spending so far is kept on record, and work already sent may still finish and be charged.

## 4. Review a trial before the full run

For a trial, check every automatically filed document against the original and both systems' reasoning. Mark each placement **Right** or **Wrong**, then explicitly **Confirm the trial**. Counts alone never approve it. If nothing was filed automatically, review the other outcomes before deciding; your confirmation is still required.

A wrong placement or changed category version requires another trial on the current categories. You can open the editor with a document's evidence, but no example or wording is added automatically.

After a valid confirmation, **Prepare the full run** creates a local draft. It initially selects all originals, including the trial documents: every selected document is classified and charged again. Review the selection and confirm a fresh spending choice. Confirming a trial does not start the full run or reuse its classification outcomes.

## 5. Save results and build folders

When every document has an outcome, **Save a copy of the results** saves a portable results file to a new, empty file you choose. Saving results never closes the run or deletes uploaded text. The connected flow carries results into building and review without a mandatory download and re-import.

Select **Make folders on this computer**:

1. Choose the **folder of originals** used for this run. The app reads those originals locally to make copies.
2. Choose a separate **folder for the copies**, preferably a new empty folder for this run, and allow writing. Neither folder may contain the other.
3. Leave advanced filename/path options unchanged unless a path warning requires attention. The browser does not reveal an absolute path; entering one is an optional advanced check.
4. Select **Make folders**.

The builder copies files; it does not move your originals or overwrite conflicting destination files. Review its summary. Missing files and conflicts are listed. Repeating the build checks existing copies and resumes safely. Review/failure folders include explanatory Markdown sidecars.

## 6. Return your corrections

Select **Review the folders** from the same run and choose the whole output folder (the one that holds every category folder, not one category inside it); the website reads it. Then each document comes to you as one card, in two queues (since 6 October 2026):

- **Needs you**: the documents the two systems disagreed on or were not sure enough about. Choose the folder each belongs in. The card then says which copy to move into which folder in File Explorer; the website reads folders and never moves a file. Select **Look again** after moving, and the move shows as your correction.
- **Spot-check (optional)**: the filed documents, folder by folder. Say **Right** or **Wrong, it belongs in …**. A folder counts as checked once you have been through every filed document still in it; the progress line shows how many count toward the minimum sample (50 by default) that tests the filing certainty, which stays untested until then.

Keys do the same as the buttons: R, W, 1 to 9 for a folder, ← back, → next. If a document genuinely fits two categories, tick **Either folder is right** on its card after moving it; those documents are counted separately from misfile rates. Create a new folder only to propose a new type; the website asks whether it should be proposed or ignored. After a trial, documents you checked in the trial that landed in the same place again are listed as checked in the trial and not asked again; you can check them again if you wish.

Select **Save my review**. Definitions, examples and thresholds do not change automatically.

## 7. Improve your categories (optional)

The numbered steps end with the review. When your saved review confirmed or moved documents, proposed a filing certainty or named a new folder a category, the run offers **Improve your categories**: what the review shows, with a supported threshold proposal's own explicit **Apply**; **Update the categories** (an authorized editor reviews a draft and explicitly activates it) or **Keep the categories as they are**; and your answers, where you select **Save my answers**. Unchecked documents remain unconfirmed; documents marked as fitting either category remain separate from misfile rates.

Use **Run again and compare** to prepare a linked run. If the category version changed, explicitly choose **Use the same answers** only when the saved category labels still apply; nothing remaps those answers automatically. Review the new selection, trial or explicit bypass, and spending choice before starting.

The later run's Results page shows **Compared with your saved answers**. It matches documents by content, including renamed files, and reports:

- How many documents you moved now go where you placed them.
- How many previously filed documents are still filed in the same place.
- How many comparable automatic filings match your confirmed answers.

Missing, new, ambiguous, unconfirmed, excluded and failed cases are listed separately. Use the link beneath the figures to inspect automatic placements that differ from your answers; its label includes the number of documents. An unfinished comparison is labelled incomplete, including a run closed before all its documents had outcomes. These are observations on your reviewed documents, not a guarantee about future documents.

## If something stops

Read the specific headline and action first; the details preserve recorded information for your administrator. Continue an interrupted browser upload from that run's upload stage in the same browser profile. Stopped cloud processing cannot continue in the same run: prepare a new run with the unfinished documents. Retrying processing failures also requires a new run, the originals and fresh spending confirmation; it is never automatic.

**Delete uploaded text...** is a separate explicit action that closes a completed run and deletes its uploaded text, outline and source-containing full state. Results, decisions and retained vendor evidence stay available. Closing an unfinished run requires explicit discard confirmation and leaves no complete results file. If closing is interrupted, **Finish closing this run** requires another explicit click. Keep the originals.

Outline notes remain visible. With the full-text policy, missing or recovered headings alone do not require review; automatic filing still requires both systems to agree at or above the certainty threshold. Other notes and processing failures retain their review or failure outcome. Earlier runs keep their recorded policy and results.


When the correction summary says no automatically filed documents were checked, the denominator is zero because none of the checked items had been automatically filed. A move from human review to a category still records useful feedback; it does not establish automatic-filing accuracy. Only mark a folder checked after reviewing all documents in it.
