// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * Stand-in for what VS Code's webview host gives a page: the theme's CSS variables (Dark Modern), the body classes,
 * and acquireVsCodeApi(). Every message the page posts is recorded in window.__posted and handed to
 * window.__hostReply (harness/codex-host.js) so it can be answered. Messages from the host are dispatched as
 * MessageEvents on window, which is how VS Code delivers them.
 */
(function () {
  'use strict';
  var THEME = {
    'font-family': 'system-ui, "Ubuntu", "Droid Sans", sans-serif', 'font-weight': 'normal', 'font-size': '13px',
    'editor-font-family': '"Droid Sans Mono", "monospace", monospace', 'editor-font-weight': 'normal', 'editor-font-size': '14px',
    'foreground': '#cccccc', 'disabledForeground': 'rgba(204,204,204,0.5)', 'descriptionForeground': '#9d9d9d',
    'errorForeground': '#f85149', 'icon-foreground': '#cccccc', 'focusBorder': '#0078d4',
    'textLink-foreground': '#4daafc', 'textLink-activeForeground': '#4daafc', 'textSeparator-foreground': 'rgba(255,255,255,0.18)',
    'textPreformat-foreground': '#d0d0d0', 'textPreformat-background': '#3c3c3c', 'textBlockQuote-background': '#2b2b2b',
    'textBlockQuote-border': '#616161', 'textCodeBlock-background': '#2b2b2b',
    'editor-background': '#1f1f1f', 'editor-foreground': '#cccccc', 'editor-selectionBackground': '#264f78',
    'editor-findMatchBackground': '#9e6a03', 'editorWidget-background': '#202020', 'editorWidget-foreground': '#cccccc',
    'editorWidget-border': '#313131', 'editorWarning-foreground': '#cca700', 'editorError-foreground': '#f14c4c',
    'editorInfo-foreground': '#3794ff', 'editorGroup-dropBackground': 'rgba(83,89,93,0.5)',
    'editorGroup-dropIntoPromptBackground': '#202020', 'widget-border': '#313131', 'widget-shadow': 'rgba(0,0,0,0.36)',
    'sideBar-background': '#181818', 'sideBar-foreground': '#cccccc', 'sideBar-border': '#2b2b2b',
    'sideBarTitle-foreground': '#cccccc', 'sideBarSectionHeader-background': '#181818', 'sideBarSectionHeader-border': '#2b2b2b',
    'panel-background': '#181818', 'panel-border': '#2b2b2b', 'titleBar-activeBackground': '#181818',
    'titleBar-activeForeground': '#cccccc', 'titleBar-inactiveBackground': '#1f1f1f', 'titleBar-inactiveForeground': '#9d9d9d',
    'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c', 'input-placeholderForeground': '#989898',
    'inputOption-activeBorder': '#2488db', 'inputValidation-errorBorder': '#be1100', 'inputValidation-warningBorder': '#b89500',
    'dropdown-background': '#313131', 'dropdown-foreground': '#cccccc', 'dropdown-border': '#3c3c3c',
    'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1',
    'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#3c3c3c',
    'button-border': 'rgba(255,255,255,0.07)', 'badge-background': '#616161', 'badge-foreground': '#f8f8f8',
    'checkbox-background': '#313131', 'checkbox-border': '#3c3c3c', 'radio-activeForeground': '#ffffff',
    'radio-activeBackground': '#0078d4', 'radio-activeBorder': '#2488db', 'radio-inactiveBorder': 'rgba(255,255,255,0.2)',
    'list-hoverBackground': '#2a2d2e', 'list-activeSelectionBackground': '#04395e', 'list-activeSelectionForeground': '#ffffff',
    'list-activeSelectionIconForeground': '#ffffff', 'list-inactiveSelectionBackground': '#37373d', 'list-focusOutline': '#0078d4',
    'menu-background': '#1f1f1f', 'menu-foreground': '#cccccc', 'menu-selectionBackground': '#0078d4',
    'menu-separatorBackground': '#454545', 'menu-border': '#454545', 'menubar-selectionBackground': 'rgba(90,93,94,0.31)',
    'toolbar-hoverBackground': 'rgba(90,93,94,0.31)', 'toolbar-activeBackground': 'rgba(99,102,103,0.31)',
    'scrollbar-shadow': '#000000', 'scrollbarSlider-background': 'rgba(121,121,121,0.4)',
    'scrollbarSlider-hoverBackground': 'rgba(100,100,100,0.7)', 'scrollbarSlider-activeBackground': 'rgba(191,191,191,0.4)',
    'progressBar-background': '#0078d4', 'charts-foreground': '#cccccc', 'charts-red': '#f14c4c', 'charts-blue': '#3794ff',
    'charts-yellow': '#cca700', 'charts-orange': '#d18616', 'charts-green': '#89d185', 'charts-purple': '#b180d7',
    'diffEditor-insertedLineBackground': 'rgba(155,185,85,0.2)', 'diffEditor-removedLineBackground': 'rgba(255,0,0,0.2)',
    'gitDecoration-addedResourceForeground': '#81b88b', 'gitDecoration-modifiedResourceForeground': '#e2c08d',
    'gitDecoration-deletedResourceForeground': '#c74e39', 'gitDecoration-ignoredResourceForeground': '#8c8c8c',
    'terminal-background': '#181818', 'terminal-foreground': '#cccccc', 'terminal-selectionBackground': '#264f78',
    'terminal-ansiBlack': '#000000', 'terminal-ansiRed': '#cd3131', 'terminal-ansiGreen': '#0dbc79', 'terminal-ansiYellow': '#e5e510',
    'terminal-ansiBlue': '#2472c8', 'terminal-ansiMagenta': '#bc3fbc', 'terminal-ansiCyan': '#11a8cd', 'terminal-ansiWhite': '#e5e5e5',
    'terminal-ansiBrightBlack': '#666666', 'terminal-ansiBrightRed': '#f14c4c', 'terminal-ansiBrightGreen': '#23d18b',
    'terminal-ansiBrightYellow': '#f5f543', 'terminal-ansiBrightBlue': '#3b8eea', 'terminal-ansiBrightMagenta': '#d670d6',
    'terminal-ansiBrightCyan': '#29b8db', 'terminal-ansiBrightWhite': '#e5e5e5', 'tab-activeBackground': '#1f1f1f',
    'tab-inactiveBackground': '#181818', 'tab-activeForeground': '#ffffff', 'tab-inactiveForeground': '#9d9d9d', 'tab-border': '#2b2b2b',
    'statusBar-background': '#181818', 'statusBar-foreground': '#cccccc', 'sash-hoverBorder': '#0078d4',
    'keybindingLabel-background': 'rgba(128,128,128,0.17)', 'keybindingLabel-foreground': '#cccccc',
    'notifications-background': '#1f1f1f', 'notifications-foreground': '#cccccc', 'quickInput-background': '#222222',
    'quickInput-foreground': '#cccccc', 'chat-requestBackground': 'rgba(31,31,31,0.62)',
  };
  var root = document.documentElement;
  /* Set one by one through the style object, which a content policy without 'unsafe-inline' still allows, as the
     session list's page has; a style attribute it would refuse. */
  Object.keys(THEME).forEach(function (k) { root.style.setProperty('--vscode-' + k, THEME[k]); });
  root.style.colorScheme = 'dark';
  /* VS Code adds these to <body> once it exists; the layout sample shows the two Codex's tab had. */
  function bodyClasses() { document.body.classList.add('vscode-dark', 'vscode-reduce-motion'); document.body.setAttribute('data-vscode-theme-kind', 'vscode-dark'); document.body.setAttribute('data-vscode-theme-id', 'Default Dark Modern'); }
  if (document.body) bodyClasses(); else document.addEventListener('DOMContentLoaded', bodyClasses);

  window.__posted = [];
  window.__fromHost = function (msg) { window.dispatchEvent(new MessageEvent('message', { data: msg, origin: location.origin })); };
  var state = undefined, handed = false;
  window.acquireVsCodeApi = function () {
    if (handed) throw new Error('An instance of the VS Code API has already been acquired');
    handed = true;
    return Object.freeze({
      postMessage: function (m) {
        try { window.__posted.push(JSON.parse(JSON.stringify(m))); } catch (e) { window.__posted.push({ unserialisable: true }); }
        if (typeof window.__hostReply === 'function') { try { window.__hostReply(m); } catch (e) { console.error('hostReply failed', String(e && e.stack || e)); } }
      },
      getState: function () { return state; },
      setState: function (s) { state = s; return s; },
    });
  };
})();
