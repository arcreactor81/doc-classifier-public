import test from 'node:test';
import assert from 'node:assert/strict';
import { installOutbound } from './outbound.ts';
import { gatewayIssue, sendRouted, siteRoute } from './gateway.ts';
import { ANTHROPIC_MESSAGES_ENDPOINT } from './requests.ts';

/**
 * DECISIONS 156 addendum and the brief: the practice site (pretend vendors, `wrangler.fake.jsonc`) keeps working with no
 * gateway configured, because its vendors answer inside the Worker. This process installs the pretend outbound, as the
 * pretend build's entry does, so it is a pretend build from here on.
 */
const sent: string[] = [];
installOutbound(async url => { sent.push(String(url)); return new Response('{}'); });

test('a pretend build routes every vendor locally and needs no gateway; Health raises nothing', async () => {
  for (const vendor of ['openai', 'anthropic', 'deepseek', 'cloudflare', 'typesafe'] as const)
    assert.deepEqual(await siteRoute({}, vendor), { kind: 'local' }, vendor);
  assert.equal(await gatewayIssue({}), null);
  await sendRouted({}, { kind: 'local' }, ANTHROPIC_MESSAGES_ENDPOINT, { method: 'POST', body: '{}' });
  assert.deepEqual(sent, [ANTHROPIC_MESSAGES_ENDPOINT], 'the pretend vendors answer the vendor URL itself');
});
