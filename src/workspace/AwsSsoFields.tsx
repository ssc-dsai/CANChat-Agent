import { ssoConfigFromSettings } from '../shared/awsSso';
import type { Settings } from '../shared/types';
import { useT } from '../sidebar/i18n';
import { AwsSsoSignIn } from './AwsSsoSignIn';

type SsoFields = Pick<Settings, 'bedrockMantle' | 'awsSso' | 'awsSsoStartUrl' | 'awsSsoRegion' | 'awsAccountId' | 'awsSsoRoleName' | 'awsRegion'>;

/**
 * The Bedrock Mantle authentication choice plus, for IAM Identity Center, its
 * four settings and the sign-in control. Shared by the main connection form
 * (ModelSection) and the model-profile form (ModelProfilesSection).
 */
export function AwsSsoFields({ value, onChange }: { value: SsoFields; onChange: (patch: Partial<SsoFields>) => void }) {
  const t = useT();
  const text = (field: keyof SsoFields) => (e: Event) => onChange({ [field]: (e.target as HTMLInputElement).value });

  return (
    <>
      <label class="field">
        <span>{t('settings.awsAuth')}</span>
        <select
          value={value.awsSso ? 'sso' : 'key'}
          onChange={(e) => onChange({ awsSso: (e.target as HTMLSelectElement).value === 'sso' })}
        >
          <option value="key">{t('settings.awsAuthKey')}</option>
          <option value="sso">{t('settings.awsAuthSso')}</option>
        </select>
        {value.awsSso && <span class="field-note">{t('settings.awsAuthSsoNote')}</span>}
      </label>

      {value.awsSso && <>
        <label class="field">
          <span>{t('settings.awsSsoStartUrl')}</span>
          <input type="url" placeholder="https://d-1234567890.awsapps.com/start" value={value.awsSsoStartUrl ?? ''} onInput={text('awsSsoStartUrl')} />
        </label>
        <label class="field">
          <span>{t('settings.awsSsoRegion')}</span>
          <input type="text" placeholder={value.awsRegion?.trim() || 'ca-central-1'} value={value.awsSsoRegion ?? ''} onInput={text('awsSsoRegion')} />
          <span class="field-note">{t('settings.awsSsoRegionNote')}</span>
        </label>
        <label class="field">
          <span>{t('settings.awsAccountId')}</span>
          <input type="text" inputMode="numeric" placeholder="123456789012" value={value.awsAccountId ?? ''} onInput={text('awsAccountId')} />
        </label>
        <label class="field">
          <span>{t('settings.awsSsoRoleName')}</span>
          <input type="text" placeholder="BedrockUser" value={value.awsSsoRoleName ?? ''} onInput={text('awsSsoRoleName')} />
          <span class="field-note">{t('settings.awsSsoRoleNameNote')}</span>
        </label>
        <AwsSsoSignIn config={ssoConfigFromSettings({ ...value, bedrockMantle: true })} />
      </>}
    </>
  );
}
