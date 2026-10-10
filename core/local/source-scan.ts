import { scanSourceFolder, type LocalDirectoryHandle } from '../builder/browser.ts';
import type { SourceFile } from '../builder/builder.ts';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const summaryName = new RegExp(`^build-summary-${uuid}\\.md$`, 'i');
const summaryHeader = new RegExp(`^# Local build summary\\n\\nRun: (${uuid})(?:\\n|$)`, 'i');
export interface GeneratedTree { path: string; runId: string; summaryPath: string }
interface ScanOptions { signal?: AbortSignal; onProgress?: (filesHashed: number, path: string) => void }
function checkSignal(signal?: AbortSignal) { if(signal?.aborted) throw new DOMException('E_LOCAL_SCAN_CANCELLED','AbortError'); }

/** Read-only discovery; names alone never identify generated trees. Discovery does not exclude anything. */
export async function discoverGeneratedTrees(root: LocalDirectoryHandle, options: Pick<ScanOptions,'signal'> = {}): Promise<GeneratedTree[]> {
  const found: GeneratedTree[] = [];
  async function visit(directory: LocalDirectoryHandle, prefix: string) {
    checkSignal(options.signal);
    for await(const handle of directory.values()) {
      checkSignal(options.signal);
      const path=prefix ? `${prefix}/${handle.name}` : handle.name;
      if(handle.kind==='directory') await visit(handle,path);
      else if(summaryName.test(handle.name)) {
        const header=await (await handle.getFile()).slice(0,256).text();
        const match=summaryHeader.exec(header);
        if(match) found.push({path:prefix,runId:match[1],summaryPath:path});
      }
    }
  }
  await visit(root,'');
  return found;
}

/**
 * Files the operating system or an office program keeps beside documents for its own use (owner decision, 5 Oct 2026).
 * They are not documents: the scan lists their paths and never opens, hashes or records them, so nothing about them is
 * sent. The list is deliberately narrow and explicit, one pattern per kind with its own test; every other file is read
 * as usual, and a real file of a type the reader does not take is still listed as could not be read.
 */
export const NOT_DOCUMENTS: readonly RegExp[] = [
  // Windows Explorer's thumbnail cache.
  /^thumbs\.db$/i,
  // Windows folder view settings.
  /^desktop\.ini$/i,
  // macOS Finder folder view settings.
  /^\.ds_store$/i,
  // Microsoft Office owner (lock) file of an open document: only a leading "~$" on a Word, Excel or PowerPoint name.
  /^~\$.+\.(?:doc|docx|docm|dot|dotx|dotm|xls|xlsx|xlsm|xlsb|xlt|xltx|xltm|ppt|pptx|pptm|pot|potx|potm|pps|ppsx|ppsm)$/i,
  // LibreOffice lock file of an open document: ".~lock.report.docx#".
  /^\.~lock\..+#$/,
  // macOS AppleDouble file (a file's Finder data, written beside it on drives that are not Mac formatted): "._report.docx".
  /^\._.+/
];
export const isNotDocument = (name: string): boolean => NOT_DOCUMENTS.some(pattern => pattern.test(name));

export interface ExtractionScan {
  files: SourceFile[];
  /** Paths of the system and lock files left out (`NOT_DOCUMENTS`), in folder order. */
  skipped: string[];
}

/**
 * All files are included except system and lock files (`NOT_DOCUMENTS`, listed in `skipped`) and an identified
 * generated tree the user explicitly excluded.
 */
export async function scanExtractionSource(root: LocalDirectoryHandle, options: ScanOptions & {excludedGeneratedTrees?: readonly string[]} = {}): Promise<ExtractionScan> {
  const excluded=new Set(options.excludedGeneratedTrees ?? []);
  if(excluded.size>0) {
    const detected=new Set((await discoverGeneratedTrees(root,options)).map(tree=>tree.path));
    for(const path of excluded) if(!path || !detected.has(path)) throw new Error('E_LOCAL_GENERATED_TREE_SELECTION');
  }
  const skipped: string[]=[];
  function filtered(directory: LocalDirectoryHandle,prefix: string): LocalDirectoryHandle {
    return {kind:'directory',name:directory.name,
      getDirectoryHandle:directory.getDirectoryHandle.bind(directory),getFileHandle:directory.getFileHandle.bind(directory),
      async *values(){
        for await(const handle of directory.values()){
          checkSignal(options.signal);
          const path=prefix ? `${prefix}/${handle.name}` : handle.name;
          if(handle.kind==='directory') { if(!excluded.has(path)) yield filtered(handle,path); }
          else if(isNotDocument(handle.name)) skipped.push(path);
          else yield handle;
        }
      }
    };
  }
  const files=await scanSourceFolder(filtered(root,''),options);
  return {files,skipped};
}
