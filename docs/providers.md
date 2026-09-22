# Subscription-backed model connections

Last verified against official provider documentation: 2026-09-22.

CANChat uses subscription quota only through provider-documented integration
surfaces. It does not scrape chat websites, extract cookies, import another
application's credentials, reuse another application's OAuth identity, or call
private inference endpoints.

## Status

| Provider | Decision | Authentication | Billing or quota source |
|---|---|---|---|
| GitLab Duo | `blocked` | OAuth is documented, but no CANChat inference transport is verified | Not available |
| xAI / SuperGrok | `api_key_only` | User-created xAI API key | Separately billed xAI API usage |

`api_key_only` means a consumer subscription is not used. `blocked` means the
code intentionally refuses the connection rather than imitate an official
client or rely on an unverified API.

## GitLab Duo

GitLab documents Authorization Code with PKCE and its normal REST/GraphQL API.
That proves a third party can authenticate to GitLab; it does not by itself
prove that a third party may use a Duo subscription as a generic model API.

The previous CANChat experiment used public-schema `aiAction` and `aiMessages`
GraphQL fields. It was covered only by HTTP mocks and was never exercised with
a licensed tenant. Current GitLab Agent Platform documentation describes a
multi-token chain and official GitLab UI, IDE, and Duo CLI surfaces. Because no
Duo-enabled test tenant is available and no independent inference contract was
confirmed, that experiment is disabled and the provider reports `blocked`.

GitLab's official Duo CLI offers headless mode, but headless mode automatically
approves all tools. CANChat does not wrap it as a model companion without a
cross-platform sandbox and explicit tool isolation.

Activation requires both a provider-documented third-party inference contract
and an opt-in live test against a licensed GitLab.com or self-managed tenant.
The pure PKCE and GraphQL builders remain unit-tested as dormant framework code
but are not reachable through provider management or model routing.

Official references:

- <https://docs.gitlab.com/api/oauth2/>
- <https://docs.gitlab.com/user/duo_agent_platform/>
- <https://docs.gitlab.com/user/duo_agent_platform/authentication/>
- <https://docs.gitlab.com/user/gitlab_duo_cli/>

## xAI / SuperGrok

xAI's developer documentation requires an API key created in xAI Console.
Models are available through the documented Responses and Chat Completions
APIs at `https://api.x.ai/v1`. API usage requires API credits and is separate
from SuperGrok or X Premium+.

xAI does not document third-party SuperGrok OAuth client registration or an API
that applies SuperGrok quota to external applications. CANChat therefore does
not implement consumer OAuth and does not call `accounts.x.ai` subscription
endpoints. Configure an xAI API key using the normal endpoint connection.

Official references:

- <https://docs.x.ai/developers/quickstart>
- <https://docs.x.ai/developers/rest-api-reference/inference>
- <https://docs.x.ai/developers/models>

## Architecture

`SubscriptionProvider` in `src/background/providers/types.ts` owns connection,
account, models, response streaming, cancellation, refresh, and optional quota
status. `registry.ts` supplies decisions and capability flags to both the UI
and model router. The existing protocol adapters remain the default endpoint
and API-key path.

The main `complete()` gateway checks `Settings.subscriptionProvider`. When it
is absent, behavior is unchanged. When selected, it checks connection and
input capabilities before delegating to the provider. Blocked providers cannot
be selected in the model UI.

Both remaining subscription providers currently advertise `tools: false`
(GitLab Duo is `blocked` outright; xAI's subscription-OAuth path is
unsupported — see above). Subscription providers exist so the UI can state
their status truthfully; actual model calls go through the endpoint/API-key
protocol adapters (`src/background/adapters/`), including for xAI via a plain
API key.

## Security and privacy

- Provider networking runs only in the service worker.
- Provider operations are accepted only from extension pages, never content
  scripts, injected page scripts, or webpage JavaScript.
- Runtime provider IDs are allowlisted; callers cannot choose URLs, headers,
  or scopes.
- Provider errors pass through centralized credential redaction.
- No tokens, authorization codes, or account responses are logged, exported,
  included in analytics, or returned to content scripts.

## Permissions

- `identity`: reserved for a future documented PKCE flow (e.g. GitLab Duo,
  if a verified inference transport is ever confirmed).
- No provider-specific host permission was added. The pre-existing
  `<all_urls>` permission is required by CANChat's browser tool environment and
  already covers documented API calls.
- CSP remains `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.

## Adding a provider

1. Record dated official documentation for authentication, inference, models,
   quota, revocation, policy, CORS, and billing semantics.
2. Stop with `blocked` or `api_key_only` if independent registration and
   subscription inference are not explicitly supported.
3. Add pure auth/normalization helpers and mocked tests without live secrets.
4. Implement `SubscriptionProvider`, using background-only networking and the
   shared token, redaction, and timeout boundaries.
5. Add the descriptor and provider ID; render setup through capability data.
6. Add opt-in live tests for final activation. Mocked success alone is not
   sufficient to display subscription inference as supported.
