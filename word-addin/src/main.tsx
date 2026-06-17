import { render } from 'preact';
import { TaskPane } from './TaskPane';
import './styles.css';

function mount() {
  const el = document.getElementById('app');
  if (el) render(<TaskPane />, el);
}

// Inside Word, wait for Office to be ready; in a plain browser (dev), just mount.
if (typeof Office !== 'undefined' && typeof Office.onReady === 'function') {
  void Office.onReady(() => mount());
} else {
  mount();
}
