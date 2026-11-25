import { ssoConfigFromSettings, usesAwsSso } from '../../shared/awsSso';
import type { ModelProtocol, Settings } from '../../shared/types';
import { getAwsSsoCredentials } from '../awsSso';
import { signRequest, type SigV4Credentials } from '../awsSigv4';
import type { LlmMessage, ResponseFormatSpec, ToolDefinition } from '../llmTypes';
import { LlmError } from '../llmTypes';
import type { AdapterRequest, ProtocolAdapter } from './types';

// =============================================================================
// AWS Bedrock Mantle — Bedrock's OpenAI- and Anthropic-compatible endpoint at
// `bedrock-mantle.<region>.api.aws`. Mantle speaks the same wire formats as
// the Chat Completions, Responses, and Anthropic Messages adapters, so this
// is not a protocol of its own: it wraps whichever of those the connection
// selects and changes only where the request goes and how it authenticates.
//  - Endpoint: blank `baseUrl` = the region's default Mantle base for the
//    chosen protocol (`/v1` for the OpenAI shapes, `/anthropic` for Messages).
//    Some models are served under `/openai/v1` instead; set `baseUrl` to
//    `https://bedrock-mantle.<region>.api.aws/openai/v1` for those.
//  - Auth, three modes:
//      * Bedrock API key (no `awsAccessKeyId`): `apiKey` is sent the way the
//        inner adapter already sends a key (Bearer / x-api-key).
//      * AWS credentials (`awsAccessKeyId` set): `apiKey` is the secret
//        access key, plus optional `awsSessionToken`; the request is signed
//        with SigV4 for the `bedrock-mantle` service.
//      * IAM Identity Center (`awsSso` set): the request is SigV4-signed with
//        the signed-in user's temporary role credentials (../awsSso.ts);
//        `apiKey` and `awsAccessKeyId` are ignored.
//  - Signing needs the async Web Crypto API, so `buildRequest` is async.
// =============================================================================

const MANTLE_SERVICE = 'bedrock-mantle';

/** Default Mantle base URL for a region and the wire protocol the request will use. */
function defaultMantleBaseUrl(region: string, protocol: ModelProtocol | undefined): string {
  const host = `https://bedrock-mantle.${region}.api.aws`;
  return protocol === 'anthropic-messages' ? `${host}/anthropic` : `${host}/v1`;
}

/** SigV4-sign a built request for Mantle, dropping any key header the inner adapter set. */
async function sign(req: AdapterRequest, region: string, credentials: SigV4Credentials): Promise<AdapterRequest> {
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([name]) => !/^(authorization|x-api-key|api-key)$/i.test(name)),
  );
  const signed = await signRequest('POST', req.url, JSON.stringify(req.body), region, MANTLE_SERVICE, credentials);
  return { ...req, headers: { ...headers, ...signed } };
}

/** Wrap a Chat Completions / Responses / Anthropic Messages adapter so it targets Bedrock Mantle. */
export function withBedrockMantle(inner: ProtocolAdapter, protocol: ModelProtocol | undefined): ProtocolAdapter {
  return {
    async buildRequest(settings: Settings, messages: LlmMessage[], tools?: ToolDefinition[], responseFormat?: ResponseFormatSpec): Promise<AdapterRequest> {
      if (protocol === 'gemini-native') {
        throw new LlmError('AWS Bedrock (Mantle) does not serve the Gemini native API. Choose Chat Completions, Responses, or Anthropic Messages in Settings → Models.');
      }
      const region = settings.awsRegion?.trim();
      if (!region) throw new LlmError('AWS Bedrock requires a region. Set it in Settings → Models.');
      const base = (settings.baseUrl?.trim() || defaultMantleBaseUrl(region, protocol)).replace(/\/+$/, '');

      if (usesAwsSso(settings)) {
        const cfg = ssoConfigFromSettings(settings);
        if (!cfg) {
          throw new LlmError('AWS IAM Identity Center sign-in needs a start URL, account ID, and permission set. Set them in Settings → Models.');
        }
        const req = await inner.buildRequest({ ...settings, baseUrl: base, apiVersion: undefined, apiKey: '' }, messages, tools, responseFormat);
        return sign(req, region, await getAwsSsoCredentials(cfg));
      }

      const secret = settings.apiKey?.trim();
      const accessKeyId = settings.awsAccessKeyId?.trim();
      if (!secret) {
        throw new LlmError(
          accessKeyId
            ? 'AWS Bedrock requires the secret access key for this access key ID. Set it in Settings → Models.'
            : 'AWS Bedrock requires a Bedrock API key (or an AWS access key ID and secret access key). Set it in Settings → Models.',
        );
      }

      // Azure's api-version quirk never applies here, and in SigV4 mode the
      // secret must not leak into a Bearer/x-api-key header.
      const req = await inner.buildRequest(
        { ...settings, baseUrl: base, apiVersion: undefined, apiKey: accessKeyId ? '' : secret },
        messages,
        tools,
        responseFormat,
      );
      if (!accessKeyId) return req;
      return sign(req, region, {
        accessKeyId,
        secretAccessKey: secret,
        sessionToken: settings.awsSessionToken?.trim() || undefined,
      });
    },

    parseResponse: inner.parseResponse,
  };
}
