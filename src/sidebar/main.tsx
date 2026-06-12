import { render } from 'preact';
import { Sidebar } from './Sidebar';
import './styles.css';

// Apply the saved text size before first paint (no resize flash).
const savedScale = Number(localStorage.getItem('ba_ui_scale'));
if (savedScale >= 0.8 && savedScale <= 1.6) {
  document.documentElement.style.zoom = String(savedScale);
}

render(<Sidebar />, document.getElementById('app')!);
