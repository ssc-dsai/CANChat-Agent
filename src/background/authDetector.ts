import type { AuthState, PageContent } from '../shared/types';

const LOGIN_URL_PATTERN = /(login|log-in|signin|sign-in|sign_in|auth|sso|oauth|saml|session|account\/login)/i;

const LOGIN_TEXT_PATTERN =
  /(sign in to continue|log in to continue|please sign in|please log in|session (has )?expired|authentication required|you must (sign|log) in)/i;

const LOGIN_TITLE_PATTERN = /(sign in|log in|login|authenticate)/i;

const PROVIDER_PATTERNS: Array<[RegExp, string]> = [
  [/accounts\.google\.com/i, 'Google'],
  [/login\.microsoftonline\.com|login\.live\.com/i, 'Microsoft'],
  [/\.okta\.com/i, 'Okta'],
  [/\.auth0\.com/i, 'Auth0'],
  [/\.onelogin\.com/i, 'OneLogin'],
  [/\.pingidentity\.com|\.pingone\./i, 'Ping Identity'],
  [/id\.atlassian\.com/i, 'Atlassian'],
];

/**
 * Multi-signal auth detection over extracted page content. Each signal is
 * weak on its own; combinations raise confidence.
 */
export function analyzeAuthState(content: PageContent): AuthState {
  if (content.extractionStatus === 'blocked' || content.extractionStatus === 'unsupported') {
    return { status: 'blocked', reason: 'Page content is not accessible to the extension.' };
  }

  const hasPasswordInput = content.metadata['ba:hasPasswordInput'] === 'true';
  const hasLoginForm = content.metadata['ba:hasLoginForm'] === 'true';
  const urlLooksLikeLogin = LOGIN_URL_PATTERN.test(content.url);
  const titleLooksLikeLogin = LOGIN_TITLE_PATTERN.test(content.title);
  const textLooksLikeLogin = LOGIN_TEXT_PATTERN.test(content.text.slice(0, 5000));

  let detectedProvider: string | undefined;
  for (const [pattern, name] of PROVIDER_PATTERNS) {
    if (pattern.test(content.url)) {
      detectedProvider = name;
      break;
    }
  }

  const signals = [
    hasPasswordInput,
    hasLoginForm,
    urlLooksLikeLogin,
    titleLooksLikeLogin,
    textLooksLikeLogin,
    detectedProvider !== undefined,
  ].filter(Boolean).length;

  if (hasPasswordInput || detectedProvider || signals >= 2) {
    const reasons: string[] = [];
    if (hasPasswordInput) reasons.push('password input present');
    if (hasLoginForm) reasons.push('login form present');
    if (urlLooksLikeLogin) reasons.push('URL matches login pattern');
    if (titleLooksLikeLogin) reasons.push('title indicates sign-in');
    if (textLooksLikeLogin) reasons.push('page text requests sign-in');
    if (detectedProvider) reasons.push(`identity provider: ${detectedProvider}`);
    return {
      status: 'auth_required',
      reason: reasons.join('; '),
      loginUrl: content.url,
      detectedProvider,
    };
  }

  if (content.text.length < 50) {
    return { status: 'unknown', reason: 'Page has very little readable content.' };
  }
  return { status: 'authenticated' };
}
