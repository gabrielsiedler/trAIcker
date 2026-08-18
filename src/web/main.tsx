import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './styles.css';

// The same bundle serves the browser and the desktop shell, so the shell is
// detected rather than built for. The user-agent test is what keeps it that
// way: a preload script exposing a flag would mean a second build artefact and
// a privileged bridge, for one boolean.
//
// Desktop-only styling exists because the shell hides the title bar to run the
// content to the window edge — that leaves the OS window controls sitting on
// top of the page, which the layout has to make room for. In a browser tab
// none of that applies.
if (navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('is-desktop');
  document.documentElement.classList.add(
    navigator.userAgent.includes('Mac OS X') ? 'is-desktop-mac' : 'is-desktop-win',
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
