import { usageCopy } from './copy-usage.ts';
import { trialCopy } from './copy-trial.ts';
import { bakeoffCopy } from './copy-bakeoff.ts';
import { journeyCopy } from './copy-journey.ts';
import { commonCopy } from './copy-common.ts';
import { shellCopy } from './copy-shell.ts';
import { filesCopy } from './copy-files.ts';
import { confirmCopy } from './copy-confirm.ts';
import { progressCopy } from './copy-progress.ts';
import { phasesCopy } from './copy-phases.ts';
import { reasonsCopy } from './copy-reasons.ts';
import { resultsCopy } from './copy-results.ts';
import { evidenceCopy } from './copy-evidence.ts';
import { buildCopy } from './copy-build.ts';
import { reviewCopy } from './copy-review.ts';
import { improveCopy } from './copy-improve.ts';
import { compareCopy } from './copy-compare.ts';
import { categoriesCopy } from './copy-categories.ts';
import { homeCopy } from './copy-home.ts';
import { systemCopy } from './copy-system.ts';
import { helpCopy } from './copy-help.ts';
import { errorsCopy } from './copy-errors.ts';
import { lightCopy } from './copy-light.ts';

export const uiCopy = {
  usage: usageCopy,
  bakeoff: bakeoffCopy,
  trial: trialCopy,
  chooseFollowupFiles: 'Choose files for the comparison run', comparisonSetupTitle: 'Compare your next run with your saved corrections', comparisonSetupDetail: 'Your category changes and confirmed labels are saved. Choose the originals below to prepare a new comparison run. Classification starts only after you confirm its spending settings.', generatedFoldersTitle: 'Previous output copies found inside this folder', generatedFoldersDetail: 'These folders contain copies created by an earlier build. Keep them in place and exclude them from this extraction so the originals are processed once.', excludeGenerated: 'Exclude output copies and use the originals', generatedRoot: 'This is a generated output folder. Choose the original source folder instead; your corrected copies will stay unchanged.', useFolderNewExtraction: 'Use this folder for a new extraction',

  categorySuggestions: 'Suggested changes from your corrections', categoryUseExample: 'Add this excerpt as an example', categoryUseExclusion: 'Use this exclusion', categorySuggestionHelp: 'These excerpts are partial evidence. Review the original before choosing an example, then edit it if needed. Nothing is added until you choose it.', categoryExampleAdded: 'Example added to your unsaved draft.', categoryExclusionAdded: 'Exclusion added to your unsaved draft.', categoryAccessDetails: 'Editor access setup', categoryActor: 'Your signed-in account identifier', categoryAccessHelp: 'The deployment owner can add this identifier to DEFINITION_EDITORS to grant category editing. This page cannot grant itself permission.', runAdvanced: 'Download, close or stop a run', referenceUnconfirmedCount: (count:number)=>`${count} documents still have no confirmed category.`, referenceAllowUnconfirmed: 'Continue with these documents excluded as unconfirmed', referenceInvalidPair: 'Choose two different categories for each ambiguous document.', categoriesUntested: 'These categories have not been tested yet. Automatic filing starts conservatively at 90% certainty.', runNoteExtractorMixed: 'These documents were read by more than one version of the text extraction step. This is recorded for reference and does not send documents to review.', startingClassification: 'Text uploaded. Starting document checks...', comparisonEligible: 'eligible documents', comparisonGroupTotal: 'documents in this group', referenceTitle: 'Confirm the answers for your next run', referenceHelp: 'Your confirmed labels are the reference. Both acceptable categories can be recorded for uncertain documents; these are counted separately.', referenceSave: 'Confirm labels for comparison', referenceSaving: 'Saving your confirmed labels...', referenceFolder: 'Connect this folder to a category', referenceStatus: 'Your decision', referenceLabel: 'One category', referenceAmbiguous: 'Either category is acceptable', referenceExcluded: 'Exclude from comparison', referenceUnconfirmed: 'Not confirmed', referenceFailure: 'Processing failure - excluded', referenceFirst: 'First acceptable category', referenceSecond: 'Other acceptable category', referenceCategory: 'Category', comparisonTitle: 'What changed after your corrections?', comparisonMoved: 'Moved documents now matching your choice', comparisonFiled: 'Previously filed documents still filed the same way', comparisonProvisional: 'This comparison is still in progress. Pending and missing documents are not successes.', comparisonMissing: 'Missing documents', comparisonAmbiguous: 'Ambiguous - excluded from accuracy', comparisonExcluded: 'Explicitly excluded', comparisonFailures: 'Processing failures', comparisonNew: 'New documents without a prior label', comparisonUnconfirmed: 'Unconfirmed labels', pipelineTitle: 'Your document journey', pipelineSteps: ['Choose files','Follow progress','Build folders','Review corrections','Activate categories'],
  searchDocuments: 'Search documents', previousPage: 'Previous', nextPage: 'Next', pageCount: (start:number,end:number,total:number)=>`${start}-${end} of ${total}`,
  resultsReady: 'Results ready', resultsLoading: 'Preparing your results...', resultsRetained: 'Building folders does not delete uploaded text. Close the run when you are finished.',
  optionalDownload: 'Download a backup of the results file', continueReview: 'Review category changes', folderConflict: 'Choose an output folder outside your source folder so copied files are not scanned again.',
  currentJourney: 'Continue your current run', categoryTitle: 'Teach the workspace your categories.', categoryLede: 'Describe what belongs in each category. Review and activate a complete set before using it in a new run.',
  categoryName: 'Category name used by both models', categoryDisplay: 'Name shown on the website', categoryMeaning: 'What belongs here?', categoryExclusions: 'What does not belong here?', categoryExamples: 'Examples - one per line',
  categoryAdd: 'Add a category', categoryRemove: 'Remove this category from the draft', categoryNew: 'New category', categorySave: 'Save for review', categorySaving: 'Saving your category draft...',
  categoryDraftSaved: 'Draft saved. Review the categories, then activate when ready.', categoryActivate: 'Activate these categories', categoryActivating: 'Activating your category version...', categoryActivated: 'Categories activated. Future runs will use this version; earlier runs are unchanged.',
  categoryReadOnly: 'You can view categories. An authorised editor must save or activate changes.', categoryGit: 'Website editing is not enabled for this deployment. Ask the workspace administrator to enable category editing.',
  categoryReview: 'Review before activation', categoryDrafts: 'Saved drafts', categoryOpenDraft: 'Open draft', categoryActive: 'Active categories', categoryEmpty: 'Add at least one category before saving.', categoryNoneName: 'Name when no category fits', categoryNoneMeaning: 'When should no category apply?', categoryId: 'Stable category identifier',
  preparingRun: 'Preparing your run...', monitorFallback: 'Your browser did not open the progress window. Progress will open here when upload finishes.',
  ambiguityTitle: 'Some documents can belong to either category', ambiguityHelp: 'Record both acceptable categories. These documents are counted separately and excluded from misfile calculations.',
  correctionPending: 'Reviewing your corrections?', correctionSaved: 'Your corrections are saved.', evidenceOptional: 'Supporting evidence (optional)',

  heroAction: 'Start with a folder', heroSecondary: 'See how it works', heroTrust: 'Your files. Your decisions.',
  processLabel: 'How a document finds its place', processInput: 'Your documents', processInputDetail: 'Text is extracted on your machine', processDecision: 'Agreement + certainty', processDecisionDetail: 'Rules determine the outcome', processResult: 'Organized folders. Clear exceptions.',
  workspaceTools: 'WORKSPACE', workspaceSupport: 'SUPPORT', stepLabel: 'Step',
  buildGuideTitle: 'Three selections. One organized folder.', buildGuideDetail: 'Use a completed run. Keep your original source folder unchanged, and choose a separate output folder.',
  buildResultsTitle: 'Select the results file', buildResultsDetail: 'Your completed run supplies these results directly. Choose a saved backup only when restoring an older run.',
  buildSourceTitle: 'Select your originals', buildSourceDetail: 'Choose the same source folder used for the run. These are the documents the app will copy.',
  buildDestinationTitle: 'Choose where the copies go', buildDestinationDetail: 'Choose a separate, empty output folder for the first build. Reuse it only to resume that build.',
  buildPathTitle: 'Check the destination path', buildAdvanced: 'Advanced filename and path settings', buildNext: 'After building: review the output folder, move any misplaced documents, then open Corrections.',
  selectionPending: 'Not selected yet', selectionReady: 'Selected', nextStep: 'Next step', openCorrections: 'Review folder corrections', openBuild: 'Create your local folders', openRun: 'Open run', startRun: 'Start a run',
  correctionGuideTitle: 'Review on your machine. Bring back the changes.',
  correctionGuideSteps: [
    {title:'Move documents',detail:'Open the output folder you built. Move each misplaced document into the right category folder. Keep its tagged filename unchanged.'},
    {title:'Select the whole output folder',detail:'Choose the results file for that run, then the output folder containing all category folders.'},
    {title:'Confirm what you checked',detail:'Tick only the folders whose documents you personally checked, then review the corrections below.'},
  ],
  correctionResultsTitle: '1. Select the results file for this run', correctionFolderTitle: '2. Select the corrected output folder', correctionCheckedHelp: 'A folder left unchecked is not treated as confirmation that its documents are correct.',
  correctionNothingFiled: 'No automatically filed documents were confirmed in this review. Folder moves are still recorded; this does not establish filing accuracy.',
  emptyRunsTitle: 'Your first run starts with a folder.', emptyRunsDetail: 'Choose documents on your machine, review the spending limits, and confirm. Progress and results will appear here.',
  readyDetail: 'The required configuration checks passed. Review spending limits before starting a run.', healthIntro: 'Check setup, spending activation, and the information this workspace retains.',
  setupTypeTitle: 'Define your document categories', setupTypeAction: 'Open Categories to define names, descriptions, exclusions and examples, then review and activate them.',
  setupModelsTitle: 'Activate model calls when you are ready', setupModelsAction: 'Model calls are switched off. Finish defining your categories, then enable MODEL_CALLS_ENABLED in the deployment configuration. This permits paid calls; it does not start a run.',
  preflightReady: 'Extract a source folder, choose your spending limits, then select Review run.',

  providerWaitOpenai:'OpenAI requested a pause. This run is waiting before sending another request.', providerWaitTypesafe:'TypeSafe requested a pause. This run is waiting before sending another request.',
  documentFilename:'Document', resultExplanation:'Outcome details',
  workspaceLabel:'DOCUMENT WORKSPACE', navigationLabel:'Workspace navigation', privacyFootnote:'Your originals stay on your machine.', workspaceEyebrow:'LESS SORTING. MORE CLARITY.', sourceEmptyTitle:'A folder is all you need to begin.', sourceEmptyBody:'Choose a folder to extract its text and structure locally. You review the run before anything is uploaded.', setupStatus:'Setup needs attention', operationalStatus:'Ready for a new run', systemStatus:'System status',
  flowSteps:[{title:'Extract locally',detail:'Keep the originals on your machine.'},{title:'Review both opinions',detail:'See the evidence behind each outcome.'},{title:'Build and refine',detail:'Create folders and bring back corrections.'}],

  conditionalNotFor: (fromName:string,toName:string,toWhat:string) => 'Do not use "'+fromName+'" when "'+toName+'" is the closer fit under this definition: "'+toWhat+'".',
  proposalRetainedReader: 'Retained reader evidence', proposalReaderVerdict: 'Reader verdict', proposalQuoteProvenance: 'Quote provenance', proposalFrozenDefinitions: 'Frozen type definitions', proposalTypeVersion: 'Type version',
  proposalPartialContext: 'Full document context is unavailable here. Retained reader quotes are only partial evidence; review the original document before accepting an example.',

  evidenceOpen:'View recorded evidence', evidenceReload:'Refresh recorded evidence', evidenceConfidence:'Confidence check', evidenceReader:'Reader', evidenceChoice:'Selected type', evidenceCertainty:'Certainty', evidenceType:'Type', evidenceRationale:'Reason', evidenceQuotes:'Exact source quotes', evidenceAlternative:'Closest alternative', evidenceNone:'None', evidenceNoQuotes:'No evidence quotes were returned.', evidenceMissing:'No validated output has been recorded for this stage.', evidenceMismatch:'The evidence response does not match the selected document.',
  unrecognizedApiError: 'The server returned an unrecognized error response.',
  resultFiled:'Filed', resultReview:'Review', resultFailed:'Could not process', resultPriority:'Review first', resultPending:'Processing', resultUploaded:'Uploaded', resultQueued:'Queued', resultUnavailable:'Outcome unavailable', resultDetailsUnavailable:'Recorded details are unavailable.', resultDestination:'Destination', resultPriorityHeader:'Priority', resultRule:'Rule',
  proposalReview: 'Your corrections are saved', proposalReviewHelp: 'Review category changes before activating them for future runs. Your previous results remain unchanged.',
  proposedExamples: 'Proposed examples', proposedExclusions: 'Proposed exclusions', proposedTypes: 'Proposed types', proposalDownload: 'Download suggestions',
  proposalType: 'Type', proposalEvidence: 'Evidence tags', proposalIdentifier: 'Suggested identifier', proposalIdentifierMissing: 'Choose a category on the Categories page.',
  proposalIncompleteType: 'Complete the description, exclusions and examples on the Categories page before activation.', proposalNoExcerpt: 'No retained excerpt is available. Review the original document.',
  proposalNoExamples: 'No example candidates were proposed.', proposalNoExclusions: 'No exclusion candidates were proposed.', proposalNoTypes: 'No new types were proposed.',

  correctionManifestRequired: 'Choose the results file for this run before selecting the corrected output folder.',
  correctionTreeHelp: 'Choose the whole output folder containing the category folders, not an individual category folder.',
  correctionRescan: 'The run or results file changed. Choose the corrected output folder again before reviewing corrections.',
  latestVendorAttempt: 'Latest recorded attempt', vendorRole: 'Role', vendorAttemptTime: 'Recorded at', vendorUnknownSpend: 'Calls with unknown spend', vendorRoleReader: 'Reader', vendorRoleConfidence: 'Confidence check', vendorRoleRecovery: 'Outline recovery',
  vendorStatus: 'Vendor status',
  healthUnavailable: 'Unavailable', 

  proposalContextUnavailable: 'Full document context is unavailable for some proposed examples. Any retained reader quotes are partial evidence. Review the original documents before accepting examples.',
  invalidProjectCopy: 'Project copy contains a missing value, unknown or protected key, HTML, or prohibited wording. Correct the project pack in Git.',
  budgetTitle: 'Spending limits for this run', budgetMode: 'Budget choice', budgetLimited: 'Set spending limits', budgetUnlimited: 'Run without spending limits',
  budgetBlended: 'Blended \u00b7 both vendors', budgetOpenai: 'OpenAI', budgetTypesafe: 'TypeSafe', budgetUsd: 'Limit in USD', budgetHelp: 'Set at least one limit. You can combine an overall limit with separate vendor limits. An empty field leaves that category without its own limit.',
  budgetRequired: 'Enter at least one positive spending limit, or explicitly choose to run without spending limits.', invalidBudget: 'Enter a positive USD amount using up to 30 digits before the decimal point and up to nine decimal places.',
  unlimitedAcknowledgement: 'I understand that this run has no spending limit and may continue incurring charges.', unlimitedNeedsAcknowledgement: 'Acknowledge the no-limit warning before starting.',
  spendUnavailable: 'Spend information is unavailable.', spendLimit: 'Limit', noCategoryLimit: 'No separate limit', noSpendingLimits: 'No spending limits',
  pendingAccounting: 'Vendor work awaiting final spend',
  knownSpend: 'Known spend subtotal', unaccountedSpend: 'Vendor calls with unresolved charges',
  product: 'Document classification', browser: 'Use Chrome or Edge', browserReason: 'Your documents stay on your machine. Chrome and Edge provide the folder access needed to build and review your local tree.',
  nav: { home: 'Home', runs: 'Runs', build: 'Make folders', correct: 'Review folders', health: 'System', help: 'How it works', categories: 'Categories' },
  theme: 'Change colour theme', skip: 'Skip to content', loading: 'Loading…', refresh: 'Refresh', details: 'Technical details', retry: 'Try again',
  hero: 'Make sense of every document.', lede: 'Two independent systems review each document. A document is filed only when both agree with enough certainty and no blocking issues. Everything else comes back to you.',
  local: 'Choose your documents', localDetail: 'Only extracted text and structure are uploaded after you confirm a run.',
  setup: 'A few things before your first run', setupDetail: 'Your app is available, but processing stays locked until these setup steps are complete. Configuration changes currently need to be saved in the project repository and deployed.',
  newLocal: 'Start a new local extraction', localSession: 'Reselect the source folder to resume this local extraction. Previously failed documents remain recorded; use a new extraction to retry.',
  supportedFormats: 'Supported formats: PDF, Word (.docx), and PowerPoint (.pptx). Older .doc and .ppt files are unsupported.',
  chooseSource: 'Choose source folder', source: 'Source folder', extraction: 'Local extraction', files: 'Files', duration: 'Measured elapsed time', extracted: 'Extracted', failure: 'Could not process',
  alreadyConfirmed: 'This local extraction already has a confirmed run. Resume its upload, or explicitly start a new local extraction for another run.',
  duplicateContent: 'Duplicate document content was found. Review the source folder before creating a run; no file has been silently removed.',
  sourceSetChanged: 'This saved extraction does not match the selected folder. Choose the previous source folder, or use this folder for a new extraction. Your earlier results stay saved.',
  extractionIncomplete: 'Local extraction is unfinished. Reselect the source folder to resume it.',
  quoteAction: 'Review run', override: 'Run anyway without a spending limit', overrideWarning: 'This run has no spending limit. Actual spend will be shown live and recorded, but nothing will stop the run on cost. Individual failed requests may have unresolved charges. Global credential, model or storage failures can still stop work; you can also stop it manually.',
  projectedDuration: 'Projected minimum at published limits', uploads: 'Text uploads completed',
  preflight: 'Review and start', pendingEstimate: 'Set your spending limits before sending extracted text. Your original files stay on this machine.',
  uploadUnavailable: 'Upload is unavailable until project configuration and the run submission service are ready.',
  estimateChanged: 'The project or run settings changed. Review the run and confirm again before starting.',
  retryFailed: 'Retry failed documents in a new run', retryDetail: 'Choose the original source folder. Only matching failed documents are extracted into a new local session; new spending limits and your confirmation are required before any upload.',
  retryParent: 'Retry of run', retryMissing: 'Some retry originals are missing or changed. Choose the correct folder before reviewing the run; changed originals need an ordinary new extraction.', retryScope: 'The local retry scope contains unrelated or duplicate identities.',
  invalidRetry: 'The retry identity or parent-document listing is invalid.', excludedRetry: 'Outside this retry; not extracted', 
  runs: 'Your runs', runsLede: 'Follow each run, inspect its decisions, and download the results when every document has an outcome.', noRuns: 'No runs have been recorded.', runId: 'Run', status: 'Status', progress: 'Documents completed', spend: 'Recorded spend', textHeld: 'Uploaded text is still held', textDeleted: 'Uploaded text has been deleted',
  download: 'Download results file', close: 'Close run and delete uploaded text', kill: 'Halt all runs', noManifest: 'The results file is available after every document has an outcome.', documents: 'Documents', events: 'Recorded events',
  build: 'Turn results into real folders.', buildLede: 'Create organized copies on your machine. Your originals stay untouched, and existing files are never overwritten.', manifest: 'Choose results file', destination: 'Choose destination folder', destinationPath: 'Full destination folder path', pathHelp: 'The browser does not reveal the full path. Enter it so the builder can check path lengths before copying.', maxPath: 'Maximum path length', maxName: 'Maximum filename length', naming: 'Filename style', original: 'Tag and original filename', short: 'Tag and extension', buildAction: 'Build folders', stop: 'Stop after current file', buildComplete: 'Every document and required decision note is present.', buildIncomplete: 'The build needs attention. See each result and the summary saved in the destination.',
  unknownFolder: 'New type, or ignore these?', chooseDecision: 'Choose a decision', newType: 'Propose a new type', ignoreFolder: 'Ignore these files',
  from: 'Previous folder', to: 'Corrected folder',
  filedCount: (wrong:number, checked:number) => String(wrong)+' of '+String(checked)+' filed documents were wrong.',
  correctionSummary: (newTypes:number, unmatched:number, deleted:number) => String(newTypes)+' proposed types; '+String(unmatched)+' unmatched files; '+String(deleted)+' missing files excluded.',
  correct: 'Your judgment makes the difference.', correctLede: 'Move documents into the right folders, then show the app what changed. Nothing is applied to future runs without approval.', tree: 'Choose corrected output folder', checked: 'Which folders did you check?', analyze: 'Review corrections', correctionRun: 'Run identifier', listing: 'Documents in the corrected folder', noAutomatic: 'Your folder moves are feedback. You decide which category changes to activate.',
  health: 'System check', ready: 'READY', notReady: 'NOT READY', blockers: 'What needs attention', versions: 'Versions and project configuration', callsEnabled: 'Model calls are enabled', callsDisabled: 'Model calls are disabled', heldRuns: 'Runs still holding uploaded text', project: 'Project configuration · read only',
  error: 'This action could not finish.', errorAction: 'Check the details below and retry when the problem is resolved.', requestFailed: 'The server rejected the request.', summary: 'Summary file', yes: 'Yes', no: 'No',
  helpTitle: 'Two opinions. One set of rules. Your decision when it matters.',
  wrongTitle: 'When something goes wrong', 
  faqTitle: 'Common questions', 

  // Copy groups of the rebuilt UI (SPEC §6.5): one file per group, edited only by its owning work package.
  // Screen copy uses `screen<Group>` names to avoid the existing flat keys above.
  journey: journeyCopy,
  common: commonCopy,
  shell: shellCopy,
  screenFiles: filesCopy,
  screenConfirm: confirmCopy,
  screenProgress: progressCopy,
  phases: phasesCopy,
  reasons: reasonsCopy,
  screenResults: resultsCopy,
  evidence: evidenceCopy,
  screenBuild: buildCopy,
  review: reviewCopy,
  improve: improveCopy,
  compare: compareCopy,
  categories: categoriesCopy,
  home: homeCopy,
  system: systemCopy,
  help: helpCopy,
  errors: errorsCopy,
  light: lightCopy,
} as const;
