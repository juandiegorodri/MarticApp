const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Auth ---
  login: (credentials) => ipcRenderer.invoke('login', credentials),
  logout: () => ipcRenderer.invoke('logout'),
  getUserSession: () => ipcRenderer.invoke('get-user-session'),
  onForceLogout: (callback) => ipcRenderer.on('force-logout', () => callback()),
  onSessionActive: (callback) => ipcRenderer.on('session-active', (_event, value) => callback(value)),

  // --- Main ---
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.send('save-config', config),
  getHistory: () => ipcRenderer.invoke('get-history'),
  
  // --- UI ---
  openExternalLink: (url) => ipcRenderer.send('open-external-link', url),
  copyToClipboard: (text) => ipcRenderer.send('copy-to-clipboard', text),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  closeSettingsWindow: () => ipcRenderer.send('close-settings-window'),

  // --- Audio ---
  onStartRecording: (callback) => ipcRenderer.on('start-recording', (_event, value) => callback(value)),
  onStopRecording: (callback) => ipcRenderer.on('stop-recording', () => callback()),
  sendAudio: (data) => ipcRenderer.send('audio-recorded', data),
  sendVisualizationData: (data) => ipcRenderer.send('visualization-data', data),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_event, value) => callback(value)),
  toggleAudioTest: (deviceId) => ipcRenderer.send('toggle-audio-test', deviceId),
  onTestFinished: (callback) => ipcRenderer.on('test-finished', (_event, value) => callback(value)),
  onAudioData: (callback) => ipcRenderer.on('audio-data', (_event, value) => callback(value)),
  
  // --- Updater & Version ---
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_event, value) => callback(value)),
  restartApp: () => ipcRenderer.send('restart-app'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.send('check-for-updates-manual'),

  // --- Onboarding, Analytics & History ---
  getNewAnalyticsData: () => ipcRenderer.invoke('get-new-analytics-data'),
  completeOnboarding: () => ipcRenderer.send('complete-onboarding'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  exportHistory: () => ipcRenderer.invoke('export-history'),
});

