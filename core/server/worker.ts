import { handle } from './api.ts';
export { DocumentWorkflow } from './workflow.ts';
export default { fetch: handle } satisfies ExportedHandler<Env>;