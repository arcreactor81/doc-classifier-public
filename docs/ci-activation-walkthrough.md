# Repair this project's Cloudflare deployment permissions

Historical incident walkthrough, 23 September 2026. Later handoff evidence records the owner's permission repair and successful build. The steps below explain that incident; they are not a request to edit tokens or retry a deployment now. For current revision, resource and migration checks, use [private deployment and rollout](deployment.md). No cloud permission was rechecked for this documentation update.

Checked against official Cloudflare documentation on 2026-09-23. This is an owner browser walkthrough; no token or Access configuration was changed while preparing it.

The project is already connected to GitHub. Its deploy command is **npm run deploy:owner -- validation**. Keep that command and the existing project/Access settings. The reported deployment failure concerns permission to attach the existing account-level secrets, not missing vendor key values.

## 1. Identify the token used by this Worker

Open the [Cloudflare dashboard](https://dash.cloudflare.com/), choose the account, then **Workers & Pages > doc-classifier-generic > Settings > Build** (some dashboard views label this section **Builds**). Find **API token** and note the selected token's name. This is the deployment token, not either vendor API key.

Cloudflare documents this settings location and supports user-owned tokens for Workers Builds. [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

## 2. Add the missing permission to that token

Open [My Profile > API Tokens](https://dash.cloudflare.com/profile/api-tokens). Locate the exact token selected above and open its **Edit** action. Keep its existing deployment permissions and account restriction; add:

| Permission selection | Access | Purpose |
|---|---|---|
| Account > Account Secrets Store | Edit | Attach the two existing Secrets Store bindings during deployment |
| Account > D1 | Edit | Apply the repository's D1 schema migrations before deployment, if this permission is not already present |

The first permission can appear as **Account Secrets Store Edit** or **Secrets Store > Edit**. Read access only allows metadata inspection and is insufficient to bind a secret to a Worker. Both existing vendor secrets have already been checked as active with the workers scope; their values do not need to be replaced. [Secrets Store access control](https://developers.cloudflare.com/secrets-store/access-control/)

D1 writes require D1 Edit; a read-only token cannot apply migrations. [D1 permission clarification](https://developers.cloudflare.com/d1/platform/release-notes/#2025-05-02)

Keep **Account Resources** restricted to the project's account. Retain the existing Workers deployment/Workflows, R2 and route permissions needed by this already configured project. This is a targeted addition, not a request to grant all account permissions. Do not add API-token-management permissions or Access-policy-edit permissions to repair this deployment.

Review the summary and save the token edit. Cloudflare supports editing a token after creation. Editing permissions does not require copying its secret value into chat. [Token configuration](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)

If the selected token is shared with unrelated projects, do not broaden that shared token merely for this app: create a dedicated user-owned deployment token in Cloudflare, preserving the required existing deployment permissions plus the two permissions above, and select it only for this Worker. Keep any token value inside Cloudflare's secure token selection/input flow. If you cannot edit the selected token, an account administrator or its owning user must do this step. No vendor keys or token values should be sent to the assistant.

## 3. Retry this project's build

Return to the Worker's **Settings > Build** and confirm the intended token is selected. Keep **npm run deploy:owner -- validation** as the deploy command. Retry the latest failed build for the intended Git revision; updated build settings apply to retries. [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

Success means the build log completes checks, D1 migrations and Worker deployment without the Secrets Store authorization error. Then verify the deployed Health page reports the intended build and no new blockers. A successful deploy does not submit documents or call a model.

Tell the assistant only **token permission updated** and, if available, the build status or build link. The assistant can verify the resulting build without receiving a credential value. If a different permission error remains, share its message with values redacted rather than repeatedly rotating vendor keys.

## Why the assistant needs this browser step

The connected MCP credential was denied token-management access (code 9109), even though it can inspect the existing secret metadata. That limits what the assistant can change; it does not establish that your account lacks authority. The browser session of the token owner or administrator can make this targeted permission edit. No change to Cloudflare Access is needed for this repair.
