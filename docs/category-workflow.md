# Categories, corrections and the next run

This guide follows the current screens (updated 7 October 2026). Local tests and the click-through flows exercise them; the complete deployed workflow and unassisted usability acceptance are still pending. A successful build is not evidence that a person has completed these steps without help. The [user walkthrough](user-walkthrough.md) describes every step of a run.

## Before your first run

The site owner enables sign-in, names the category editors, connects the readers the site offers and approves model spending. These are administration tasks for the maintained private installation, described in [deployment and rollout](deployment.md). Ordinary users need no development tools or repository access.

1. Open **Categories**. A category editor can choose **Edit categories**; everyone else can read the categories but not change them.
2. In **Describe your categories**, give each category a **Category name**, **What belongs here**, **What doesn't belong here** (name the category it is most easily confused with, and say what tells them apart) and **Examples, one per line (at least one)**. Use examples you have checked against the original documents. **Add a category** adds another; the last fields name and describe documents that fit no category.
3. Choose **Review changes**. This saves a draft; it does not change the categories in use.
4. **Check before using these categories** shows what changes. Then choose **Activate these categories**. Activation is explicit. If the categories changed since your draft was made, your edits are kept and you open the editor again, rather than overwriting the other change.
5. New or changed definitions start automatic filing at 90% certainty. Choose **Keep the current filing certainty** only when the meaning of the categories has not changed.
6. Check **System**. It says whether the app is set up to run; model calls stay switched off until the site owner enables them.

An initial category set is never inferred from the first visitor. Nor does possession of a sign-in account automatically confer editing rights.

## Run, build and review

Choose a source folder in Chrome or Edge and let the browser read it. On **Check, then start the run**, choose the **Reader model** where the site offers a menu, check the **Daily allowance** on a shared site, and set a **Spending limit** (or choose **Run with no spending limit** under **More spending options** and tick its acknowledgement). Then select **Start run**. Originals stay on your machine; the cloud receives extracted text and document structure. Keep the originals available for the local folder build.

The reader is chosen for each run and recorded with it. Each reader keeps its own track record and filing certainty for each category version: a trial or a checked sample on one reader says nothing about another, so a reader new to these categories starts at 90%, untested, and a full run after a trial uses the trial's reader. On the owner's site the menu offers GPT-5.4, GPT-5.4 mini and two experimental readers, Qwen 3.8 27B (Cloudflare) and DeepSeek Flash; beside each a line says who processes the text.

On a shared site the site's daily allowances apply as well as your own limit: on the owner's site, at most 60 documents per run, 3 new runs per person per UTC day, and a shared daily allowance for each reader. If an allowance runs out, the run stops with a plain reason; it never switches to another reader. See [run spending](run-spending.md).

For a collection above the configured trial size (currently 25), the recommended path begins with a small trial. Review every automatically filed placement against the original and both systems' evidence, mark each right or wrong, and explicitly confirm the trial before preparing the full run. A trial with no automatic filings still requires a person's confirmation. Wrong placements or a changed category version require a new trial on the current version. Alternatively, explicitly choose **Use all documents without a trial**; the bypass is recorded and does not approve spending. The full run is a new spending decision; its default selection includes the trial documents, which are classified and charged again.

To stop your own run while it is being sorted, select **Discard this run…** on its Progress screen: it stops, its uploaded text is deleted and it never has a results file. Only the site owner (a listed category editor) can stop all runs on the site.

After the run completes, choose **Make folders on this computer** and a destination folder outside the source folder. Review the category definitions before judging placements.

In **Review the folders**, choose the whole folder of copies, not one category inside it. Each document then comes to you as a card, in two queues:

- **Needs you**: the documents the two systems disagreed on or were not sure enough to file. Choose the folder each belongs in.
- **Spot-check** (optional): the automatically filed documents, folder by folder. Say **Right** or **Wrong** and where it belongs instead. Until enough filed documents have been checked (50 by default), the filing certainty is untested; checking only the documents that came to you cannot measure wrong automatic filings.

A card tells you which copy to move into which folder in File Explorer; the app reads your folders and never moves a file, so select **Look again** after moving. If a document genuinely fits two categories, tick **Either folder is right** on its card; those documents are counted separately from misfile rates. After a trial, documents you checked in the trial that landed in the same place again count as checked and are not asked again. A new folder you make proposes a category, or you choose to ignore its files; it activates nothing. Then select **Save my review**. Saving records your feedback; it does not change any definition or the filing certainty.

**Save a copy of the results** is optional and never closes the run. **Delete uploaded text...** is a separate explicit action.

## Improve your categories (optional)

When your saved review confirmed or moved documents, proposed a filing certainty or named a new folder a category, the run offers **Improve your categories** after the eight steps. **What your review shows** says how many filed documents you checked, how many were in the wrong folder and where they belonged. Each of the following is your own choice; the app proposes and applies nothing on its own:

- A supported filing-certainty proposal has its own **Apply**. Only a category editor can apply it, and it stays provisional until a second review supports it.
- **Update the categories** opens the editor, which offers the new folders from your review as categories to describe; an editor reviews the draft and activates it. Or choose **Keep the categories as they are**.
- **Your answers** lists the right folder for each document, as your review showed: one category, either of two, or left out. Documents in folders you did not tick stay unconfirmed and are never counted as right or wrong. **Save my answers** keeps them for comparison.

A change of meaning starts the filing certainty at 90% again. A proposal from an older category version cannot change another version's filing certainty. Existing runs keep their original category definitions and decisions.

## Run again and compare

**Run again and compare** prepares a linked run. If the categories changed since, choose **Use the same answers with version …** only when the saved labels still apply; nothing remaps them automatically. Choose the original folder again, then review the selection, the trial or explicit bypass, the reader and the spending before starting. Comparison never requires a cloud collection of originals.

The later run's Results page shows **Compared with your saved answers**. Documents are matched by their content, even when their names change. It reports:

- Of the documents you moved, how many now go where you put them.
- Of previously filed documents, how many are still automatically filed in the same place.
- How many comparable automatic filings match your confirmed answers.

Unconfirmed, either-of-two, left-out, new, missing and failed documents are shown separately. A run that has not finished, or closed before every document had an outcome, is labelled as not final. A document whose content changed does not count as the same document. These are observations on your reviewed documents, not a guarantee about future documents.

## What is still pending

The acceptance milestone requires the deployed website sequence to be exercised, its fingerprint comparison verified, and a nontechnical user to complete it without chat coaching. Visual acceptance includes AA contrast in the supported dark theme, the owner-approved motion catalogue, readable explanations and compact results rather than an endless expanded document list.

GEPA remains deferred. No automatic replay or extra inference spending is authorized by saving corrections or activating categories.
