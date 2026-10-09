/**
 * The few rules React Native Web can't express as a style prop, injected once
 * into the page (SEN-179). Today that is the scrollbar: left alone, Chrome
 * draws a bright white native one beside every list on the night-ink ground.
 * Thin and dim instead, a board line rather than a browser fixture.
 * `scrollbar-*` covers Chrome and Firefox; the `::-webkit-` rules cover
 * Safari, which ignores the standard pair.
 */
import { color } from './palette';

const ID = 'sente-web-styles';

const CSS = `
:root { color-scheme: dark; }
* { scrollbar-width: thin; scrollbar-color: ${color.lineStrong} transparent; }
::-webkit-scrollbar { width: 8px; height: 8px; background: transparent; }
::-webkit-scrollbar-thumb {
  background: ${color.lineStrong};
  border: 2px solid transparent;
  border-radius: 8px;
  background-clip: padding-box;
}
::-webkit-scrollbar-corner { background: transparent; }
`;

export function installWebStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(ID)) return;
  const style = document.createElement('style');
  style.id = ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
