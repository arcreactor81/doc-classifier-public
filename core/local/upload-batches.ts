interface UploadIssue { index: number; error: unknown }

/** Finish the first upload before starting others, preserving the single-request stop on a bad connection.
 * Each subsequent group is sent in order and fully drained, including local acknowledgements, under the send lock. */
export async function uploadBatches(indices: readonly number[], upload: (index: number) => Promise<void>): Promise<UploadIssue[]> {
  const width = 3;
  let offset = 0;
  while (offset < indices.length) {
    const group = indices.slice(offset, offset + (offset === 0 ? 1 : width));
    const results = await Promise.allSettled(group.map(async index => upload(index)));
    const issues: UploadIssue[] = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected') issues.push({ index: group[i], error: result.reason });
    });
    if (issues.length) return issues;
    offset += group.length;
  }
  return [];
}
