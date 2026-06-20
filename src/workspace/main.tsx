import { render } from 'preact';
import { LanguageProvider } from '../sidebar/i18n';
import { Workspace } from './Workspace';
import './workspace.css';

render(
  <LanguageProvider>
    <Workspace />
  </LanguageProvider>,
  document.getElementById('app')!,
);
