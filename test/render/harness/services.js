// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * What the stand-in host's services answer (harness/codex-host.js), as Codex's extension host would. The names are the
 * services Codex 26.1021's host gives its page; a service or method not named here answers undefined, which the page
 * takes as nothing set. `window.__renderConfig.settings` holds Codex's own settings for the scene, by their keys
 * (show-context-window-usage turns on Codex's context meter). All values are made up.
 */
(function () {
  'use strict';
  var config = window.__renderConfig || {};
  var settings = config.settings || {};
  window.__renderServices = {
    serviceNames: ['accountInfo', 'agentInstructions', 'appInfo', 'applicationState', 'clientCoordination', 'clipboard', 'commandKeybindings',
      'commentAttachments', 'composerHandoff', 'computerUseSettings', 'connectorOAuth', 'copilot', 'customAgents', 'customAvatars',
      'executionPaths', 'fastModeEstimates', 'fileAttachments', 'gitFiles', 'gitMessageGeneration', 'gitRepository', 'github',
      'hostAuthentication', 'httpFetch', 'ideOnboarding', 'mailProvider', 'microphoneCapture', 'modelReviewComments',
      'nativeApplications', 'openIn', 'permissionPolicy', 'projectCatalog', 'projectPresentation', 'queuedFollowUps',
      'queuedSendLocks', 'recommendedSkills', 'repositoryOrigins', 'requestUserInputAutoResolution', 'runtimeInfo', 'settings',
      'startup', 'threadConfiguration', 'threadMetadata', 'threadMetadataGeneration', 'threadProjectAssignments', 'websitePreviews',
      'workbench', 'workspaceFiles', 'workspaceRoots', 'worktreeComposerEducation', 'worktreeSnapshots'],
    services: {
      settings: { readAll: function () { return { values: settings, configuredValues: settings }; } },
      appInfo: {
        get: function () { return { version: config.version, buildNumber: null, buildFlavor: 'prod', osName: 'Linux', systemVersion: null, appName: 'VS Code' }; },
        getSystemInfo: function () { return { platform: 'linux', osVersion: '5.10.0', isVsCodeRunningInsideWsl: false }; },
        getPackagingInfo: function () { return { isPackaged: false }; },
        getLocaleInfo: function () { return { ideLocale: 'en', systemLocale: 'en-US' }; },
      },
      executionPaths: {
        readCodexHome: function () { return '/home/demo/.codex'; },
        readHomePaths: function () { return { codexHome: '/home/demo/.codex', workspacesRoot: null, worktreesSegment: null }; },
        readHomeDirectory: function () { return { homeDirectory: '/home/demo' }; },
      },
      queuedFollowUps: { read: function () { return { state: undefined }; }, write: function () { return undefined; } },
      copilot: {
        isAvailable: function () { return false; },
        getProxyInfo: function () { return null; },
        getPreferences: function () { return { useForInference: false, defaultModel: null, showLoginFirst: false }; },
      },
      applicationState: { read: function () { return { value: undefined }; }, write: function () { return { success: true }; } },
      accountInfo: {
        readAccountInfo: function () {
          return { status: 'ready', data: { accountId: 'acct-demo', userId: 'user-demo', plan: 'pro', email: 'demo.user@example.com',
            computeResidency: null, hasChatGptToken: true } };
        },
      },
      threadConfiguration: {
        readMcpConfig: function () { return { config: null }; },
        readDeveloperInstructions: function (a) { return { instructions: (a && a.baseInstructions) || '' }; },
      },
      httpFetch: { fetch: function () { throw new TypeError('Failed to fetch'); }, cancel: function () { return undefined; } },
    },
  };
})();
