/**
 * The pretend-vendor build's entry (DECISIONS 31 item 6): the owner's live entry (`worker.ts`: legacy Access, Static
 * Assets) with every model call answered inside the Worker. Installed at module load, before any request, and only
 * here: `wrangler.fake.jsonc` is the only configuration whose `main` names this file. The runtime constructs the
 * Workflow with the raw bindings, so the Workflow class below wraps its own environment: wrapping the request handler
 * alone would leave every Workflow vendor call without a credential.
 */
import { installOutbound } from '../vendors/outbound.ts';
import { fakeVendorFetch, withFakeSecrets } from '../vendors/fake-vendors.ts';
import { handle } from './api.ts';
import { DocumentWorkflow as RealDocumentWorkflow, type DocumentParams } from './workflow.ts';

installOutbound(fakeVendorFetch);

export { withFakeSecrets };

export class DocumentWorkflow extends RealDocumentWorkflow {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, withFakeSecrets(env));
  }
}
export type { DocumentParams };

export default {
  fetch: (request, env) => handle(request, withFakeSecrets(env))
} satisfies ExportedHandler<Env & { ASSETS?: Fetcher }>;
