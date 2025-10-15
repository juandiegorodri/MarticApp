const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, clipboard, screen, shell, dialog, Notification, net } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const robot = require('robotjs');
const fs = require('fs');
const loudness = require('loudness');

// --- Configuración del Auto-Updater ---
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.info('App starting...');

// --- Manejo de Errores Globales ---
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  log.error(`Uncaught Exception: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  log.error(`Unhandled Rejection: ${reason}`);
});

const store = new Store({
  clearInvalidConfig: true,
  defaults: {
    lastActiveUserEmail: null,
    users: {}
  }
});

// --- Variables Globales de Estado ---
let tray = null;
let settingsWindow = null;
let floatingIconWindow = null;
let isRecording = false;
let currentAction = null;
let originalVolume = null;
let audioStartTime = null;
let initialSelectedText = '';
let sessionRefreshInterval = null;
let lastSuccessfulResult = '';

// --- Constantes y Configuración ---
const SERVER_URL = 'https://jdweblab.com/marticapp';
const defaultConfig = {
  'smart-transcribe-hotkey': 'Control+Shift+S',
  'process-text-hotkey': 'Control+Shift+D',
  'launch-on-startup': false,
  'attenuate-audio': true,
  'final-action': 'paste',
  'active-prompt-name': 'Resumen Ejecutivo',
  'floating-icon-position': 'bottom-right',
  'audio-device': 'default',
  'colors': {
    transcribe: '#ef4444',
    processText: '#3b82f6',
    processing: '#f59e0b'
  },
  'processing-mode': 'selectedText',
  'transcription-settings': {
    addPunctuation: true,
    removeFillers: false,
    correctGrammar: true,
  },
  'prompts': {
    transcribeBase: "Eres un asistente de transcripción de audio que busca la la mayor velocidad y eficiencia para el usuario. Entrega solamente el texto perfectamente transcrito, a menos que se te pidan más ediciones o tratamientos del texto.",
    library: [{
      name: 'Resumen Ejecutivo',
      prompt: 'Eres un asistente de transcripción de audio. Por favor, procesa el texto que se te entrega según las indicaciones del usuario, o resuelve sus dudas basado en el texto entregado, si no hay texto entregado por el usuario resuelve su duda, entrega solo la respuesta.'
    }, {
      name: 'Traducir a Inglés',
      prompt: 'Eres un traductor experto. Traduce el siguiente texto de forma precisa y natural.'
    }]
  },
  'apiConfig': {
    gcpProjectId: 'gen-lang-client-0346579390',
    geminiApiBase: 'https://generativelanguage.googleapis.com/v1',
    geminiModelId: 'gemini-1.5-flash'
  },
  'hasCompletedOnboarding': false
};

const bookMilestones = [
    { words: 3000, text: (w) => `Has escrito el equivalente a "Veinte poemas de amor y una canción desesperada" de Pablo Neruda (¡unas ${w.toLocaleString('es')} palabras!).`},
    { words: 15000, text: (w) => `Tu producción de palabras ya supera a "El Principito" de Antoine de Saint-Exupéry (¡más de ${w.toLocaleString('es')} palabras!).`},
    { words: 77000, text: (w) => `¡Felicidades! Has escrito más palabras que "Harry Potter y la piedra filosofal" (llevas ${w.toLocaleString('es')}).`},
    { words: 145000, text: (w) => `Con ${w.toLocaleString('es')} palabras, has superado la extensión de "Cien años de soledad" de Gabriel García Márquez.`},
    { words: 206000, text: (w) => `¡Impresionante! Has transcrito más palabras que las que tiene la novela "Moby Dick" (más de ${w.toLocaleString('es')}).`},
    { words: 381000, text: (w) => `¡Una hazaña épica! Con ${w.toLocaleString('es')} palabras, has escrito más que la primera parte de "Don Quijote de la Mancha".`}
].sort((a, b) => b.words - a.words);

const defaultStats = {
  transcription: 0,
  processing: 0,
  firstUseDate: new Date().toISOString()
};
const defaultHistory = [];

let userSession = {
  isLoggedIn: false,
  user: null,
  accessToken: null,
  tokenExpiresAt: 0
};

// --- Lógica del Auto-Updater (Conservada del original) ---
function checkForUpdates() {
  log.info('[Updater] Buscando actualizaciones...');
  if (settingsWindow) {
    settingsWindow.webContents.send('update-status', { status: 'checking' });
  }
  autoUpdater.checkForUpdatesAndNotify();
}

autoUpdater.on('update-available', () => {
  log.info('[Updater] Actualización disponible.');
  if (settingsWindow) settingsWindow.webContents.send('update-status', { status: 'available' });
});

autoUpdater.on('update-not-available', () => {
  log.info('[Updater] No hay actualizaciones disponibles.');
  if (settingsWindow) settingsWindow.webContents.send('update-status', { status: 'not-available' });
});

autoUpdater.on('update-downloaded', () => {
  log.info('[Updater] Actualización descargada.');
  if (settingsWindow) settingsWindow.webContents.send('update-status', { status: 'downloaded' });
  dialog.showMessageBox({
    type: 'info',
    title: 'Actualización Lista',
    message: 'Una nueva versión de MarticApp ha sido descargada. ¿Quieres reiniciar la aplicación para instalarla ahora?',
    buttons: ['Reiniciar Ahora', 'Más Tarde']
  }).then(result => {
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
});

autoUpdater.on('error', (err) => {
  log.error(`[Updater] Error: ${err.message}`);
  if (settingsWindow) settingsWindow.webContents.send('update-status', { status: 'error', message: err.message });
});

ipcMain.on('restart-app', () => autoUpdater.quitAndInstall());

// --- Gestión de Perfiles y Datos ---
function getUserData(email, key) {
  const path = `users.${email}.${key}`;
  const defaults = { 'config': defaultConfig, 'history': defaultHistory, 'stats': defaultStats };
  return store.get(path, defaults[key]);
}

function setUserData(email, key, value) {
  store.set(`users.${email}.${key}`, value);
}

// --- Gestión de Ventanas y Menú ---
function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 800,
    height: 750,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => settingsWindow = null);
  // **CORRECCIÓN**: Se elimina el listener 'dom-ready' que causaba un bucle de re-login.
  // El front-end (settings.html) ya se encarga de solicitar el estado de la sesión al cargar.
}

function createFloatingIconWindow() {
  if (floatingIconWindow) return;
  floatingIconWindow = new BrowserWindow({
    width: 40, height: 40, frame: false, transparent: true,
    alwaysOnTop: true, resizable: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  positionFloatingIcon();
  floatingIconWindow.loadFile('floating-icon.html');
}

function positionFloatingIcon() {
  if (!floatingIconWindow || !userSession.isLoggedIn) return;
  const position = getUserData(userSession.user.email, 'config')['floating-icon-position'];
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const [winWidth, winHeight] = floatingIconWindow.getSize();
  let x, y;
  switch (position) {
    case 'top-left': x = 10; y = 10; break;
    case 'top-right': x = width - winWidth - 10; y = 10; break;
    case 'bottom-left': x = 10; y = height - winHeight - 10; break;
    default: x = width - winWidth - 10; y = height - winHeight - 10; break;
  }
  floatingIconWindow.setPosition(Math.round(x), Math.round(y));
}

function updateTrayMenu() {
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Copiar última transcripción',
            enabled: !!lastSuccessfulResult,
            click: () => {
                if (lastSuccessfulResult) {
                    clipboard.writeText(lastSuccessfulResult);
                    new Notification({ title: 'MarticApp', body: 'Último resultado copiado al portapapeles.' }).show();
                }
            }
        },
        { type: 'separator' },
        { label: 'Configuración', click: createSettingsWindow },
        { type: 'separator' },
        { label: 'Salir', click: () => app.quit() }
    ]);
    if (tray) tray.setContextMenu(contextMenu);
}

// --- Ciclo de Vida de la App ---
app.whenReady().then(() => {
  tray = new Tray(path.join(__dirname, 'assets/icon.png'));
  tray.setToolTip('MarticApp');
  updateTrayMenu();
  autoLogin();
  createFloatingIconWindow();
  setTimeout(checkForUpdates, 3000);
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => {
  if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);
  globalShortcut.unregisterAll();
});

// --- Lógica de Grabación y Atajos ---
function registerHotkeys() {
  globalShortcut.unregisterAll();
  if (!userSession.isLoggedIn) return;
  const config = getUserData(userSession.user.email, 'config');
  const hotkeys = {
    transcribe: config['smart-transcribe-hotkey'],
    processText: config['process-text-hotkey']
  };
  try {
    if (hotkeys.transcribe) globalShortcut.register(hotkeys.transcribe, () => handleHotkey('transcribe'));
    if (hotkeys.processText) globalShortcut.register(hotkeys.processText, () => handleHotkey('processText'));
  } catch (err) {
    console.error('[Hotkey-ERROR] Fallo al registrar atajos:', err);
  }
}

function handleHotkey(action) {
  if (isRecording && action !== currentAction) return;
  isRecording ? stopRecording() : startRecording(action);
}

async function smoothlyChangeVolume(targetVolume, duration = 300) {
    try {
        const startVolume = await loudness.getVolume();
        const steps = 10;
        const stepDuration = duration / steps;
        const volumeChangePerStep = (targetVolume - startVolume) / steps;
        for (let i = 1; i <= steps; i++) {
            const nextVolume = Math.round(startVolume + (volumeChangePerStep * i));
            await loudness.setVolume(nextVolume);
            await new Promise(resolve => setTimeout(resolve, stepDuration));
        }
    } catch (err) { console.error('[Volume-ERROR] No se pudo cambiar el volumen:', err); }
}

async function startRecording(action) {
  if (isRecording) return;
  
  // **CORRECCIÓN**: Validar el token ANTES de iniciar la grabación.
  try {
    console.log('[Recording] Validando token antes de grabar...');
    await getValidToken();
    console.log('[Recording] Token válido. Iniciando grabación.');
  } catch (error) {
    console.error(`[Recording-FAIL] Fallo en validación de token. No se iniciará la grabación. Error: ${error.message}`);
    // La notificación al usuario ya es manejada por getValidToken y sus funciones internas.
    return;
  }

  const config = getUserData(userSession.user.email, 'config');
  if (action === 'processText') {
    const previousClipboardContent = clipboard.readText();
    clipboard.clear();
    robot.keyTap('c', ['control']);
    await new Promise(resolve => setTimeout(resolve, 200));
    initialSelectedText = clipboard.readText();
    clipboard.writeText(previousClipboardContent);
  }
  if (config['attenuate-audio']) {
    try {
        originalVolume = await loudness.getVolume();
        await smoothlyChangeVolume(10);
    } catch (err) { console.error('[Main-ERROR] No se pudo atenuar el volumen:', err); }
  }
  isRecording = true;
  currentAction = action;
  audioStartTime = Date.now();
  const colors = config.colors;
  const recordingColor = colors[action === 'transcribe' ? 'transcribe' : 'processText'];
  floatingIconWindow.webContents.send('update-status', { status: 'recording', color: recordingColor });
  floatingIconWindow.webContents.send('start-recording', { deviceId: config['audio-device'] });
}

async function stopRecording() {
    if (!isRecording) return;
    if (originalVolume !== null) {
        try { await smoothlyChangeVolume(originalVolume); }
        catch (err) { console.error('[Main-ERROR] No se pudo restaurar el volumen:', err); }
        finally { originalVolume = null; }
    }
    const config = getUserData(userSession.user.email, 'config');
    floatingIconWindow.webContents.send('update-status', { status: 'processing', color: config.colors.processing });
    floatingIconWindow.webContents.send('stop-recording');
}

ipcMain.on('audio-recorded', (event, arrayBuffer) => {
  isRecording = false;
  const audioDuration = (Date.now() - audioStartTime) / 1000;
  const audioBuffer = Buffer.from(arrayBuffer);
  processAudio(audioBuffer, currentAction, audioDuration);
});

async function processAudio(audioBuffer, action, audioDuration) {
  if (action === 'test') {
    if (settingsWindow) settingsWindow.webContents.send('test-finished', false);
    return finalizeSession();
  }
  try {
    // La validación del token ya se hizo en startRecording, aquí solo lo obtenemos.
    const token = userSession.accessToken;
    const config = getUserData(userSession.user.email, 'config');
    let finalText = '';
    let historyType = '';

    if (action === 'transcribe') {
      historyType = "Transcripción Inteligente";
      finalText = await getTranscription(audioBuffer, audioDuration, token, config);
    } else if (action === 'processText') {
      const activePromptName = config['active-prompt-name'];
      historyType = `Procesamiento (${activePromptName})`;
      finalText = await processAdvancedAction(audioBuffer, audioDuration, token, config);
    }

    if (finalText) {
      lastSuccessfulResult = finalText;
      updateTrayMenu();
      const finalAction = config['final-action'];
      if (finalAction === 'paste') typeText(finalText);
      else {
        clipboard.writeText(finalText);
        new Notification({ title: 'MarticApp', body: 'Resultado copiado al portapapeles.' }).show();
        finalizeSession();
      }
      const wc = finalText.split(/\s+/).filter(Boolean).length;
      reportUsageToServer(wc, historyType);

      const email = userSession.user.email;
      const stats = getUserData(email, 'stats');
      action === 'transcribe' ? stats.transcription++ : stats.processing++;
      setUserData(email, 'stats', stats);

      const history = getUserData(email, 'history');
      history.push({ type: historyType, output: finalText, date: new Date().toISOString(), wordCount: wc });
      setUserData(email, 'history', history);
    } else {
      handleApiError("La API no devolvió texto. Revisa tu conexión o la configuración.");
    }
  } catch (error) {
    handleApiError(error.message);
  }
}

async function processAdvancedAction(audioBuffer, audioDuration, token, config) {
  const instructionText = await getTranscription(audioBuffer, audioDuration, token, config, true);
  const activePrompt = config.prompts.library.find(p => p.name === config['active-prompt-name']);
  const systemPrompt = activePrompt ? activePrompt.prompt : defaultConfig.prompts.library[0].prompt;
  let finalUserPrompt = initialSelectedText
    ? `TEXTO A PROCESAR:\n"""\n${initialSelectedText}\n"""\n\nINSTRUCCIÓN: "${instructionText}"`
    : `PREGUNTA/INSTRUCCIÓN: "${instructionText}"`;
  return await callGemini(systemPrompt, [{ text: finalUserPrompt }], token, config);
}

async function getTranscription(audioBuffer, audioDuration, token, config, rawOnly = false) {
  const rawTranscription = await callGeminiForTranscription(audioBuffer, audioDuration, token, config);
  if (rawOnly) return rawTranscription;
  const settings = config['transcription-settings'];
  const needsFormatting = settings.addPunctuation || settings.removeFillers || settings.correctGrammar;
  if (needsFormatting && rawTranscription) {
    const formatPrompt = `${config.prompts.transcribeBase}\n\nTEXTO A FORMATEAR:\n"""\n${rawTranscription}\n"""`;
    return await callGemini("Eres un editor experto.", [{ text: formatPrompt }], token, config);
  }
  return rawTranscription;
}

// --- Llamadas a APIs ---
async function callGoogleApi(url, body, token, config) {
  const headers = { 'Content-Type': 'application/json' };
  if (typeof token === 'string' && /^ya29\./.test(token)) headers['Authorization'] = `Bearer ${token}`;
  if (config.apiConfig.gcpProjectId) headers['X-Goog-User-Project'] = config.apiConfig.gcpProjectId;
  
  const response = await net.fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const resultText = await response.text();
  let result = {};
  try { result = JSON.parse(resultText); } catch { result = { raw: resultText }; }

  if (!response.ok || (result && result.error)) {
    const code = (result.error) ? result.error.code : response.status;
    const msg = (result.error) ? result.error.message : 'Unknown API error';
    throw new Error(`Error API [${code}]: ${msg}`);
  }
  return result;
}

async function callGemini(systemPrompt, userPromptParts, token, config) {
  const API_URL = `${config.apiConfig.geminiApiBase}/models/${config.apiConfig.geminiModelId}:generateContent`;
  const combinedText = `${systemPrompt}\n\n${userPromptParts.map(p => p.text).join('\n')}`;
  const body = { contents: [{ parts: [{ text: combinedText }] }] };
  const result = await callGoogleApi(API_URL, body, token, config);
  return result?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
}

async function callGeminiForTranscription(audioBuffer, audioDuration, token, config) {
  const API_URL = `${config.apiConfig.geminiApiBase}/models/${config.apiConfig.geminiModelId}:generateContent`;
  const parts = [{ text: "Transcribe el siguiente audio." }, { inline_data: { mime_type: 'audio/webm', data: audioBuffer.toString('base64') } }];
  const body = { contents: [{ parts }] };
  const result = await callGoogleApi(API_URL, body, token, config);
  const text = result?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
  if (!text) throw new Error('La transcripción regresó vacía.');
  return text;
}

// --- LÓGICA DE AUTENTICACIÓN Y SESIÓN (NUEVA Y ROBUSTA) ---

function invalidateSessionAndPromptLogin(reason = 'Por favor, inicia sesión de nuevo.') {
    console.error(`[Auth] Invalidando sesión. Razón: ${reason}`);
    userSession = { isLoggedIn: false, user: null, accessToken: null, tokenExpiresAt: 0 };
    globalShortcut.unregisterAll();
    if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);
    sessionRefreshInterval = null;

    new Notification({ title: 'MarticApp - Se requiere acción', body: `Se perdió la conexión. ${reason}` }).show();
    createSettingsWindow();
    if (settingsWindow) settingsWindow.webContents.send('force-logout');
}

async function attemptSilentRelogin() {
    const lastUserEmail = store.get('lastActiveUserEmail');
    if (!lastUserEmail) return false;
    const credentials = store.get(`users.${lastUserEmail}.credentials`);
    if (!credentials || !credentials.email || !credentials.password) return false;

    for (let i = 0; i < 3; i++) {
        console.log(`[Auto-Relogin] Intento #${i + 1} para ${lastUserEmail}`);
        try {
            const result = await handleLogin(credentials, true);
            if (result.success) {
                console.log('[Auto-Relogin] Reconexión exitosa.');
                return true;
            }
        } catch (error) { console.error(`[Auto-Relogin] Intento #${i + 1} falló:`, error.message); }
        if (i < 2) await new Promise(resolve => setTimeout(resolve, 3000 * (i + 1))); // 3s, 6s
    }
    console.error('[Auto-Relogin] Todos los intentos de reconexión fallaron.');
    return false;
}

async function getValidToken() {
    if (!userSession.isLoggedIn) {
        console.log('[Auth] getValidToken llamado sin sesión. Lanzando error.');
        throw new Error('No has iniciado sesión.');
    }
    if (userSession.accessToken && Date.now() < userSession.tokenExpiresAt) {
        console.log('[Auth] Usando token de acceso en caché.');
        return userSession.accessToken;
    }

    console.log('[Auth] Token expirado o ausente. Solicitando uno nuevo del servidor...');
    try {
        return await fetchTokenFromServer();
    } catch (error) {
        if (error.message && error.message.includes('no_session')) {
            console.warn('[Auth] Sesión del servidor perdida. Intentando reconexión silenciosa...');
            const reconnected = await attemptSilentRelogin();
            if (reconnected) {
                console.log('[Auth] Reconexión exitosa. Obteniendo nuevo token...');
                return await fetchTokenFromServer();
            } else {
                invalidateSessionAndPromptLogin('Los intentos de reconexión automática fallaron.');
                throw new Error('No se pudo reconectar.');
            }
        } else {
            invalidateSessionAndPromptLogin('Problema de comunicación con el servidor.');
            throw error;
        }
    }
}

async function fetchTokenFromServer() {
    console.log('[Auth] Pidiendo token al servidor...');
    const response = await net.fetch(`${SERVER_URL}/api_generate_token.php`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '', useSessionCookies: true
    });
    const data = await response.json();
    if (!response.ok || data.error) {
        console.error('[Auth] El servidor devolvió un error al pedir token:', data.error || 'no_session');
        throw new Error(data.error || 'no_session');
    }
    
    if (data.accessToken) {
        console.log('[Auth] Nuevo token de acceso recibido con éxito.');
        userSession.accessToken = data.accessToken;
        userSession.tokenExpiresAt = Date.now() + ((data.expiresIn || 3600) - 60) * 1000;
        if (data.apiConfig && userSession.user) {
            const config = getUserData(userSession.user.email, 'config');
            config.apiConfig = data.apiConfig;
            setUserData(userSession.user.email, 'config', config);
        }
        return data.accessToken;
    }
    console.error('[Auth] La respuesta del servidor fue exitosa pero no contenía un token.');
    throw new Error('Token no recibido del servidor.');
}

async function reportUsageToServer(wordCount, historyType) {
  if (!userSession.isLoggedIn) return;
  const type = historyType.includes('Transcripción') ? 'A' : 'B';
  const params = new URLSearchParams({ words: String(wordCount), tipo: type });
  try {
    await net.fetch(`${SERVER_URL}/report_usage.php`, {
      method: 'POST', body: params, useSessionCookies: true
    });
  } catch (err) { console.error('[UsageReport-ERROR]', err); }
}

async function autoLogin() {
  if (userSession.isLoggedIn) {
      if(settingsWindow) settingsWindow.webContents.send('session-active', userSession);
      return;
  }
  const lastUserEmail = store.get('lastActiveUserEmail');
  if (!lastUserEmail) {
      if(!settingsWindow) createSettingsWindow();
      return;
  }

  const credentials = store.get(`users.${lastUserEmail}.credentials`);
  if (credentials && credentials.email && credentials.password) {
    console.log(`[AutoLogin] Intentando para ${credentials.email}`);
    const result = await handleLogin(credentials, true); // true for silent
    if (result.success) {
      console.log('[AutoLogin] Éxito.');
      if(settingsWindow) settingsWindow.webContents.send('session-active', userSession);
    } else {
      console.warn('[AutoLogin] Falló, mostrando login.');
      if(!settingsWindow) createSettingsWindow();
    }
  } else {
    if(!settingsWindow) createSettingsWindow();
  }
}

async function handleLogin({ email, password }, isSilent = false) {
  try {
    const response = await net.fetch(`${SERVER_URL}/login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&client=desktop`,
      useSessionCookies: true
    });
    const data = await response.json();
    if (data.success) {
      userSession = { isLoggedIn: true, user: data.user, accessToken: null, tokenExpiresAt: 0 };
      let config = getUserData(email, 'config');
      if (data.apiConfig) config.apiConfig = data.apiConfig;
      setUserData(email, 'credentials', { email, password });
      setUserData(email, 'config', config);
      store.set('lastActiveUserEmail', email);
      registerHotkeys();
      positionFloatingIcon();
      startSessionRefresh();
      return { success: true, user: data.user, needsOnboarding: !isSilent && !config.hasCompletedOnboarding };
    } else {
      return { success: false, message: data.message };
    }
  } catch (error) {
    return { success: false, message: 'Error de comunicación.' };
  }
}

function startSessionRefresh() {
  if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);
  console.log('[Session] Iniciando temporizador de renovación de sesión cada 20 minutos.');
  sessionRefreshInterval = setInterval(() => {
    if (userSession.isLoggedIn) {
      console.log('[Session] Renovando sesión proactivamente...');
      getValidToken().catch(err => {
        // La lógica interna de getValidToken ya maneja la invalidación de la sesión y la notificación
        console.error('[Session-Refresh-ERROR] Falló la renovación silenciosa:', err.message);
      });
    }
  }, 20 * 60 * 1000); // 20 minutos
}

function handleLogout() {
  userSession = { isLoggedIn: false, user: null, accessToken: null, tokenExpiresAt: 0 };
  globalShortcut.unregisterAll();
  if (sessionRefreshInterval) clearInterval(sessionRefreshInterval);
  sessionRefreshInterval = null;
  if (settingsWindow) settingsWindow.webContents.send('force-logout');
  return { success: true };
}

// --- Funciones de Utilidad y Estado ---
function finalizeSession() {
  if (floatingIconWindow) floatingIconWindow.webContents.send('update-status', { status: 'idle' });
  isRecording = false;
  currentAction = null;
  initialSelectedText = '';
}

function typeText(text) {
  clipboard.writeText(text);
  robot.keyTap('v', ['control']);
  finalizeSession();
}

function handleApiError(errorMessage) {
  console.error('[Main-ERROR]:', errorMessage);
  new Notification({ title: 'MarticApp - Ocurrió un Error', body: String(errorMessage) }).show();
  finalizeSession();
}

function applyLaunchOnStartup() {
  if (!userSession.isLoggedIn) return;
  const shouldLaunch = getUserData(userSession.user.email, 'config')['launch-on-startup'];
  app.setLoginItemSettings({ openAtLogin: shouldLaunch, path: app.getPath('exe') });
}

// --- IPC Handlers (Conservados del original y verificados) ---
ipcMain.handle('login', async (event, credentials) => handleLogin(credentials));
ipcMain.handle('logout', () => handleLogout());
ipcMain.handle('get-user-session', () => userSession);
ipcMain.handle('get-config', () => userSession.isLoggedIn ? getUserData(userSession.user.email, 'config') : defaultConfig);
ipcMain.on('save-config', (event, config) => {
  if (userSession.isLoggedIn) {
    setUserData(userSession.user.email, 'config', config);
    registerHotkeys();
    positionFloatingIcon();
    applyLaunchOnStartup();
  }
});
ipcMain.handle('get-history', () => userSession.isLoggedIn ? getUserData(userSession.user.email, 'history') : []);
ipcMain.on('open-external-link', (event, url) => shell.openExternal(url));

ipcMain.on('show-context-menu', () => Menu.buildFromTemplate([
    { label: 'Copiar última transcripción', enabled: !!lastSuccessfulResult, click: () => { if (lastSuccessfulResult) clipboard.writeText(lastSuccessfulResult); } },
    { type: 'separator' }, { label: 'Configuración', click: createSettingsWindow },
    { type: 'separator' }, { label: 'Salir', click: () => app.quit() }
]).popup({ window: floatingIconWindow }));

ipcMain.on('close-settings-window', () => { if (settingsWindow) settingsWindow.close(); });

ipcMain.handle('get-new-analytics-data', () => {
    if (!userSession.isLoggedIn) return null;
    const email = userSession.user.email;
    const history = getUserData(email, 'history');
    const stats = getUserData(email, 'stats');
    const now = new Date();
    const oneWeekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    const usesThisWeek = history.filter(item => new Date(item.date) >= oneWeekAgo).length;
    let totalWords = 0, transcriptionWords = 0, processingWords = 0;
    history.forEach(item => {
        const wc = item.wordCount || 0;
        totalWords += wc;
        if (item.type.includes('Transcripción')) transcriptionWords += wc;
        else processingWords += wc;
    });
    const averageWords = history.length > 0 ? Math.round(totalWords / history.length) : 0;
    const firstUseDate = new Date(stats.firstUseDate);
    const daysWithApp = Math.max(1, Math.ceil((now - firstUseDate) / (1000 * 60 * 60 * 24)));
    const funFact = bookMilestones.find(m => totalWords >= m.words)?.text(totalWords) || "¡Sigue escribiendo para desbloquear tu primer logro literario!";
    return { usesThisWeek, totalWords, transcriptionWords, processingWords, averageWords, daysWithApp, funFact };
});

ipcMain.on('complete-onboarding', () => {
    if (userSession.isLoggedIn) {
        let config = getUserData(userSession.user.email, 'config');
        config.hasCompletedOnboarding = true;
        setUserData(userSession.user.email, 'config', config);
    }
});
ipcMain.on('toggle-audio-test', (event, deviceId) => {
  if (isRecording && currentAction === 'test') stopRecording();
  else if (!isRecording) {
    startRecording('test');
    if (settingsWindow) settingsWindow.webContents.send('test-finished', true);
  }
});
ipcMain.on('copy-to-clipboard', (event, text) => clipboard.writeText(text));
ipcMain.on('visualization-data', (event, volume) => { if (settingsWindow) settingsWindow.webContents.send('audio-data', volume); });
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.on('check-for-updates-manual', () => checkForUpdates());
ipcMain.handle('clear-history', () => {
    if (userSession.isLoggedIn) {
        setUserData(userSession.user.email, 'history', []);
        return { success: true };
    }
    return { success: false };
});
ipcMain.handle('export-history', async () => {
    if (!userSession.isLoggedIn) return { success: false, message: 'Inicia sesión.' };
    const history = getUserData(userSession.user.email, 'history');
    if (history.length === 0) return { success: false, message: 'Historial vacío.' };
    const { filePath, canceled } = await dialog.showSaveDialog({ defaultPath: `historial.csv` });
    if (canceled || !filePath) return { success: false, message: 'Exportación cancelada.' };
    let fileContent = 'Fecha,Tipo,Salida\n';
    history.forEach(item => {
        const date = `"${new Date(item.date).toLocaleString()}"`;
        const type = `"${(item.type || '').replace(/"/g, '""')}"`;
        const output = `"${(item.output || '').replace(/"/g, '""')}"`;
        fileContent += `${date},${type},${output}\n`;
    });
    try {
        fs.writeFileSync(filePath, fileContent, 'utf-8');
        return { success: true };
    } catch (error) {
        return { success: false, message: 'No se pudo guardar.' };
    }
});

