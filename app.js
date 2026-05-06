'use strict';

// ============================================================
//  קבועים
// ============================================================
const STORAGE_KEY   = 'fitness-tracker-v1';
const FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;
const SHARED_PROFILE_ID = 'main-profile';

const THEME_META_COLORS = {
  light: '#007AFF',
  dark:  '#0F172A'
};

// ============================================================
//  מצב אפליקציה
// ============================================================
let state = {
  balance:       0,
  workoutPrice:  80,
  totalWorkouts: 0,
  logs:          [],      // cache מקומי בלבד
  theme:         'light',
  todayReport:   null,    // { type: 'workout_done'|'no_workout', ... }
  dailyReportsByDate: {}  // { 'yyyy-mm-dd': { type, isFuture, source, ... } }
};

let _cloudReady       = false;
let _firebaseDb       = null;
let _firebaseUid      = null;
let _lastCloudSyncAt  = null;
let _cloudInitError   = '';
let _lastCloudError   = '';
let _editingEntryId   = null;
let _isPullRefreshing = false;
let _workoutLocked    = false;
let _isHydrating      = false;
let _cloudProfileUnsub = null;
let _cloudLogsUnsub    = null;
let _cloudReportsUnsub = null;
let _realtimeReady     = false;
let _calendarViewDate = startOfMonth(new Date());
let _selectedCalendarDateKey = '';
let _calendarFilter = 'all';

// ============================================================
//  Firebase init
// ============================================================
function hasUsableFirebaseConfig() {
  if (!FIREBASE_CONFIG || typeof FIREBASE_CONFIG !== 'object') return false;
  const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
  return required.every(k => {
    const v = FIREBASE_CONFIG[k];
    return typeof v === 'string' && v.trim() && !v.includes('REPLACE_');
  });
}

async function initFirebaseCloud() {
  if (_cloudReady) return true;
  if (!window.firebase) { _cloudInitError = 'Firebase SDK לא נטען'; return false; }
  if (!hasUsableFirebaseConfig()) { _cloudInitError = 'הגדרת Firebase חסרה'; return false; }
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    _firebaseDb  = firebase.firestore();
    try {
      const auth = firebase.auth();
      if (!auth.currentUser) await auth.signInAnonymously();
      _firebaseUid = auth.currentUser && auth.currentUser.uid;
    } catch (authError) {
      console.warn('[Fitness] Anonymous auth unavailable, continuing with shared public profile:', authError);
      _firebaseUid = null;
    }
    _cloudReady  = Boolean(_firebaseDb);
    _cloudInitError = '';
    return _cloudReady;
  } catch (e) {
    console.warn('[Fitness] Firebase init failed:', e);
    _cloudReady = false;
    _cloudInitError = formatCloudError(e);
    return false;
  }
}

function formatCloudError(e) {
  const raw = `${e?.code || ''} ${e?.message || ''}`;
  if (/api-key|referrer|invalid-api-key/i.test(raw))  return 'מפתח Firebase חסום לדומיין הנוכחי';
  if (/network|failed to fetch|offline/i.test(raw))   return 'אין גישה לשירותי Firebase';
  if (/operation-not-allowed/i.test(raw))              return 'Anonymous Sign-in כבוי ב-Firebase';
  if (/configuration-not-found/i.test(raw))            return 'Firebase Authentication לא הוגדר';
  return 'שגיאה בהתחברות לענן';
}

// ============================================================
//  Firestore paths  (/users/{uid}/...)
// ============================================================
function getUserDocRef() {
  if (!_cloudReady) throw new Error('Firebase not ready');
  return _firebaseDb.collection('users').doc(SHARED_PROFILE_ID);
}

function getPersonalUserDocRef() {
  if (!_cloudReady) throw new Error('Firebase not ready');
  if (!_firebaseUid) return null;
  return _firebaseDb.collection('users').doc(_firebaseUid);
}

function getLogsColRef()          { return getUserDocRef().collection('logs');         }
function getDailyReportRef(dk)    { return getUserDocRef().collection('dailyReports').doc(dk); }

function todayDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ============================================================
//  localStorage (גיבוי בלבד)
// ============================================================
function saveToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      balance:      state.balance,
      workoutPrice: state.workoutPrice,
      totalWorkouts:state.totalWorkouts,
      logs:         state.logs,
      theme:        state.theme,
      todayReport:  state.todayReport,
      dailyReportsByDate: state.dailyReportsByDate
    }));
  } catch (e) { console.warn('[Fitness] localStorage save failed:', e); }
}

function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        balance:      typeof p.balance      === 'number' ? p.balance      : 0,
        workoutPrice: typeof p.workoutPrice === 'number' ? p.workoutPrice : 80,
        totalWorkouts:typeof p.totalWorkouts=== 'number' ? p.totalWorkouts: 0,
        logs:         Array.isArray(p.logs) ? p.logs : [],
        theme:        p.theme || 'light',
        todayReport:  p.todayReport || null,
        dailyReportsByDate: (p.dailyReportsByDate && typeof p.dailyReportsByDate === 'object') ? p.dailyReportsByDate : {}
      };
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ============================================================
//  טעינה מהענן
// ============================================================
async function hydrateState() {
  const local = loadFromLocalStorage();
  _isHydrating = true;
  setLoadingState(true, 'טוען נתונים מהענן...');

  try {
    const ok = await initFirebaseCloud();
    if (!ok) {
      if (local) {
        Object.assign(state, local);
        refreshAllUI();
      }
      updateCloudSyncStatus('עובד במצב מקומי');
      return false;
    }

    await ensureSharedProfileInitialized();

    await withTimeout(fetchCloudSnapshotOnce(), 8000, 'טעינת ענן לקחה יותר מדי זמן');
    startRealtimeSync();
    _lastCloudError = '';
    return true;
  } catch (e) {
    console.warn('[Fitness] hydrateState failed:', e);
    _lastCloudError = String(e?.message || e || 'שגיאת סנכרון');
    if (local) {
      Object.assign(state, local);
      refreshAllUI();
    }
    updateCloudSyncStatus('שגיאת סנכרון – עובד מקומית');
    return false;
  } finally {
    _isHydrating = false;
    setLoadingState(false);
  }
}

async function fetchCloudSnapshotOnce() {
  const [userSnap, logsSnap, reportsSnap] = await Promise.all([
    getUserDocRef().get(),
    getLogsColRef().limit(500).get(),
    getUserDocRef().collection('dailyReports').limit(1500).get()
  ]);

  if (userSnap.exists) {
    const data = userSnap.data() || {};
    state.balance = typeof data.balance === 'number' ? data.balance : 0;
    state.workoutPrice = typeof data.workoutPrice === 'number' ? data.workoutPrice : 80;
    state.totalWorkouts = typeof data.totalWorkouts === 'number' ? data.totalWorkouts : 0;
    state.theme = data.theme || 'light';
  }

  state.logs = logsSnap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .sort((left, right) => getLogSortValue(right) - getLogSortValue(left));

  const reports = {};
  reportsSnap.docs.forEach(doc => {
    reports[doc.id] = { ...doc.data(), docId: doc.id };
  });
  state.dailyReportsByDate = reports;
  state.todayReport = reports[todayDateKey()] || null;

  _lastCloudSyncAt = new Date();
  updateCloudSyncStatus();
  saveToLocalStorage();
  refreshAllUI();
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then(value => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function stopRealtimeSync() {
  _cloudProfileUnsub?.();
  _cloudLogsUnsub?.();
  _cloudReportsUnsub?.();
  _cloudProfileUnsub = null;
  _cloudLogsUnsub = null;
  _cloudReportsUnsub = null;
  _realtimeReady = false;
}

function startRealtimeSync() {
  if (!_cloudReady) return;
  stopRealtimeSync();

  const initialState = { profile: false, logs: false, reports: false };

  const tryMarkReady = () => {
    if (!_realtimeReady && initialState.profile && initialState.logs && initialState.reports) {
      _realtimeReady = true;
      _lastCloudSyncAt = new Date();
      _lastCloudError = '';
      updateCloudSyncStatus();
      saveToLocalStorage();
      refreshAllUI();
    }
  };

  const onRealtimeError = error => {
    console.warn('[Fitness] realtime sync failed:', error);
    _lastCloudError = String(error?.message || error || 'Realtime נכשל');
    _realtimeReady = false;
    updateCloudSyncStatus();
  };

  _cloudProfileUnsub = getUserDocRef().onSnapshot(snapshot => {
    const data = snapshot.exists ? (snapshot.data() || {}) : {};
    state.balance = typeof data.balance === 'number' ? data.balance : 0;
    state.workoutPrice = typeof data.workoutPrice === 'number' ? data.workoutPrice : 80;
    state.totalWorkouts = typeof data.totalWorkouts === 'number' ? data.totalWorkouts : 0;
    state.theme = data.theme || 'light';
    initialState.profile = true;

    if (_realtimeReady) {
      _lastCloudSyncAt = new Date();
      saveToLocalStorage();
      refreshAllUI();
    }
    tryMarkReady();
  }, onRealtimeError);

  _cloudLogsUnsub = getLogsColRef().limit(500).onSnapshot(snapshot => {
    state.logs = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((left, right) => getLogSortValue(right) - getLogSortValue(left));
    initialState.logs = true;

    if (_realtimeReady) {
      _lastCloudSyncAt = new Date();
      saveToLocalStorage();
      refreshAllUI();
    }
    tryMarkReady();
  }, onRealtimeError);

  _cloudReportsUnsub = getUserDocRef().collection('dailyReports').limit(1500).onSnapshot(snapshot => {
    const reports = {};
    snapshot.docs.forEach(doc => {
      reports[doc.id] = { ...doc.data(), docId: doc.id };
    });
    state.dailyReportsByDate = reports;
    state.todayReport = reports[todayDateKey()] || null;
    initialState.reports = true;

    if (_realtimeReady) {
      _lastCloudSyncAt = new Date();
      saveToLocalStorage();
      refreshAllUI();
    }
    tryMarkReady();
  }, onRealtimeError);
}

async function ensureSharedProfileInitialized() {
  const sharedRef = getUserDocRef();
  const sharedSnap = await sharedRef.get();
  if (sharedSnap.exists) {
    const sharedData = sharedSnap.data() || {};
    const sharedLogs = await sharedRef.collection('logs').limit(1).get();
    if (!shouldBootstrapSharedProfile(sharedData, sharedLogs.empty)) {
      return;
    }
  }

  const personalRef = getPersonalUserDocRef();
  const personalSnap = personalRef ? await personalRef.get() : { exists: false, data: () => null };
  const legacySnap = _firebaseUid
    ? await _firebaseDb.collection('fitnessStates').doc(_firebaseUid).get()
    : { exists: false, data: () => null };
  const localState = loadFromLocalStorage();
  const bootstrap = buildBootstrapSource(personalSnap, legacySnap, localState);

  await sharedRef.set({
    balance: bootstrap.balance,
    workoutPrice: bootstrap.workoutPrice,
    totalWorkouts: bootstrap.totalWorkouts,
    theme: bootstrap.theme,
    migratedFromUid: _firebaseUid,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  if (bootstrap.logs.length) {
    const batch = _firebaseDb.batch();
    bootstrap.logs.slice(0, 500).forEach(log => {
      const docId = typeof log.id === 'string' && log.id ? log.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { id, ...payload } = log;
      batch.set(sharedRef.collection('logs').doc(docId), payload, { merge: true });
    });
    await batch.commit();
  }

  if (bootstrap.todayReport) {
    await sharedRef.collection('dailyReports').doc(todayDateKey()).set(bootstrap.todayReport, { merge: true });
  }
}

function shouldBootstrapSharedProfile(sharedData, sharedLogsEmpty) {
  const hasMeaningfulSharedData =
    Boolean(sharedData.resetAt) ||
    (typeof sharedData.balance === 'number' && sharedData.balance !== 0) ||
    (typeof sharedData.totalWorkouts === 'number' && sharedData.totalWorkouts !== 0) ||
    (typeof sharedData.workoutPrice === 'number' && sharedData.workoutPrice !== 80) ||
    !sharedLogsEmpty;

  return !hasMeaningfulSharedData;
}

function buildBootstrapSource(personalSnap, legacySnap, localState) {
  const personalData = personalSnap.exists ? (personalSnap.data() || {}) : null;
  const legacyData = legacySnap.exists ? (legacySnap.data() || {}) : null;
  const legacyState = legacyData && legacyData.state && typeof legacyData.state === 'object'
    ? legacyData.state
    : null;

  if (personalData) {
    return {
      balance: typeof personalData.balance === 'number' ? personalData.balance : 0,
      workoutPrice: typeof personalData.workoutPrice === 'number' ? personalData.workoutPrice : 80,
      totalWorkouts: typeof personalData.totalWorkouts === 'number' ? personalData.totalWorkouts : 0,
      theme: personalData.theme || (state.theme || 'light'),
      logs: [],
      todayReport: null
    };
  }

  if (legacyState) {
    return {
      balance: typeof legacyState.balance === 'number' ? legacyState.balance : 0,
      workoutPrice: typeof legacyState.workoutPrice === 'number' ? legacyState.workoutPrice : 80,
      totalWorkouts: typeof legacyState.totalWorkouts === 'number' ? legacyState.totalWorkouts : 0,
      theme: legacyState.theme || (state.theme || 'light'),
      logs: Array.isArray(legacyState.logs) ? legacyState.logs : [],
      todayReport: legacyState.todayReport || null
    };
  }

  if (localState && hasUsefulLocalState(localState)) {
    return {
      balance: typeof localState.balance === 'number' ? localState.balance : 0,
      workoutPrice: typeof localState.workoutPrice === 'number' ? localState.workoutPrice : 80,
      totalWorkouts: typeof localState.totalWorkouts === 'number' ? localState.totalWorkouts : 0,
      theme: localState.theme || (state.theme || 'light'),
      logs: Array.isArray(localState.logs) ? localState.logs : [],
      todayReport: localState.todayReport || null
    };
  }

  return {
    balance: 0,
    workoutPrice: 80,
    totalWorkouts: 0,
    theme: state.theme || 'light',
    logs: [],
    todayReport: null
  };
}

function hasUsefulLocalState(localState) {
  return Boolean(
    (typeof localState.balance === 'number' && localState.balance !== 0) ||
    (typeof localState.totalWorkouts === 'number' && localState.totalWorkouts !== 0) ||
    (typeof localState.workoutPrice === 'number' && localState.workoutPrice !== 80) ||
    (Array.isArray(localState.logs) && localState.logs.length)
  );
}

async function loadTodayReport() {
  try {
    const snap = await getDailyReportRef(todayDateKey()).get();
    state.todayReport = snap.exists ? { ...snap.data(), docId: snap.id } : null;
  } catch (e) { state.todayReport = null; }
}

// ============================================================
//  שמירה לענן
// ============================================================
async function saveUserDoc() {
  saveToLocalStorage();
  if (!_cloudReady) return false;
  try {
    await getUserDocRef().set({
      balance:      state.balance,
      workoutPrice: state.workoutPrice,
      totalWorkouts:state.totalWorkouts,
      theme:        state.theme,
      updatedAt:    firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    _lastCloudSyncAt = new Date();
    updateCloudSyncStatus();
    return true;
  } catch (e) {
    console.warn('[Fitness] saveUserDoc failed:', e);
    updateCloudSyncStatus('שגיאת שמירה לענן');
    throw e;
  }
}

async function deleteCollectionDocs(collectionRef, batchSize = 200) {
  if (!_cloudReady || !collectionRef) return;

  while (true) {
    const snap = await collectionRef.limit(batchSize).get();
    if (snap.empty) break;

    const batch = _firebaseDb.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    if (snap.size < batchSize) break;
  }
}

async function resetCloudData() {
  if (!_cloudReady) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }

  const userRef = getUserDocRef();

  await deleteCollectionDocs(userRef.collection('logs'));
  await deleteCollectionDocs(userRef.collection('dailyReports'));

  await userRef.set({
    balance: 0,
    workoutPrice: 80,
    totalWorkouts: 0,
    theme: 'light',
    resetAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  localStorage.removeItem(STORAGE_KEY);
}

async function addLogToCloud(entry) {
  if (!_cloudReady) return entry.id;
  try {
    const ref = await getLogsColRef().add({
      type:        entry.type,
      title:       entry.title,
      amount:      entry.amount,
      balanceAfter:entry.balanceAfter,
      date:        entry.date,
      time:        entry.time,
      monthKey:    entry.monthKey,
      note:        entry.note || '',
      createdAt:   firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  } catch (e) {
    console.warn('[Fitness] addLog failed:', e);
    return entry.id;
  }
}

async function updateLogInCloud(docId, fields) {
  if (!_cloudReady || !docId) return;
  try { await getLogsColRef().doc(docId).update(fields); }
  catch (e) { console.warn('[Fitness] updateLog failed:', e); }
}

async function deleteLogFromCloud(docId) {
  if (!_cloudReady || !docId) return;
  try { await getLogsColRef().doc(docId).delete(); }
  catch (e) { console.warn('[Fitness] deleteLog failed:', e); }
}

async function saveDailyReport(dateKey, data) {
  if (!_cloudReady) return;
  try {
    await getDailyReportRef(dateKey).set({
      ...data,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) { console.warn('[Fitness] saveDailyReport failed:', e); }
}

// ============================================================
//  עזרים
// ============================================================
function formatNum(n) {
  if (typeof n !== 'number' || isNaN(n)) return '0';
  return Math.round(n).toLocaleString('he-IL');
}

function formatDateTime(date) {
  if (!(date instanceof Date) || isNaN(date)) return '-';
  return date.toLocaleString('he-IL', {
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit'
  });
}

function getLogSortValue(entry) {
  const createdAt = entry?.createdAt;
  if (createdAt && typeof createdAt.toDate === 'function') {
    return createdAt.toDate().getTime();
  }

  const datePart = typeof entry?.date === 'string' ? entry.date : '';
  const timePart = typeof entry?.time === 'string' ? entry.time : '00:00';
  const match = datePart.match(/(\d{2})[./-](\d{2})[./-](\d{4})/);
  if (match) {
    const [, day, month, year] = match;
    const parsed = new Date(`${year}-${month}-${day}T${timePart}`);
    if (!isNaN(parsed)) return parsed.getTime();
  }

  const idNumber = Number(String(entry?.id || '').split('-')[0]);
  return Number.isFinite(idNumber) ? idNumber : 0;
}

function setLoadingState(isLoading, message = 'טוען נתונים...') {
  const overlay = document.getElementById('loading-overlay');
  const text = document.getElementById('loading-text');
  if (!overlay || !text) return;
  text.textContent = message;
  overlay.classList.toggle('show', isLoading);
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function buildLogEntry({ type, title, amount, balanceAfter, note = '' }) {
  const now      = new Date();
  const dateStr  = now.toLocaleDateString('he-IL', { year:'numeric', month:'2-digit', day:'2-digit' });
  const timeStr  = now.toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit' });
  const monthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
    type, title, amount, balanceAfter,
    date: dateStr, time: timeStr, monthKey, note
  };
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function dateKeyFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function dateFromDateKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function formatDateKeyForDisplay(dateKey) {
  const date = dateFromDateKey(dateKey);
  return date.toLocaleDateString('he-IL', { weekday:'short', year:'numeric', month:'2-digit', day:'2-digit' });
}

function isFutureDateKey(dateKey) {
  const target = dateFromDateKey(dateKey);
  const today = new Date();
  target.setHours(0,0,0,0);
  today.setHours(0,0,0,0);
  return target.getTime() > today.getTime();
}

function buildLogEntryForDate({ dateKey, type, title, amount, balanceAfter, note = '' }) {
  const targetDate = dateFromDateKey(dateKey);
  const now = new Date();
  const dateStr = targetDate.toLocaleDateString('he-IL', { year:'numeric', month:'2-digit', day:'2-digit' });
  const timeStr = now.toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit' });
  const monthKey = `${targetDate.getFullYear()}-${String(targetDate.getMonth()+1).padStart(2,'0')}`;

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
    type,
    title,
    amount,
    balanceAfter,
    date: dateStr,
    time: timeStr,
    monthKey,
    note
  };
}

function computeDailyFinancialDelta(oldType, newType, dateKey) {
  if (isFutureDateKey(dateKey)) {
    return { balanceDelta: 0, workoutDelta: 0 };
  }

  const price = state.workoutPrice;
  const oldWorkout = oldType === 'workout_done';
  const newWorkout = newType === 'workout_done';

  if (oldWorkout === newWorkout) {
    return { balanceDelta: 0, workoutDelta: 0 };
  }

  if (!oldWorkout && newWorkout) {
    return { balanceDelta: -price, workoutDelta: 1 };
  }

  return { balanceDelta: price, workoutDelta: -1 };
}

function statusLabel(type) {
  if (type === 'workout_done') return 'היה אימון';
  if (type === 'no_workout') return 'לא היה אימון';
  return 'ללא סימון';
}

async function setDailyStatus(dateKey, newType, source = 'calendar') {
  const cloudOk = await initFirebaseCloud();
  if (!cloudOk) {
    throw new Error('אין חיבור לענן כרגע');
  }

  const oldReport = state.dailyReportsByDate[dateKey] || null;
  const oldType = oldReport?.type || null;

  if (oldType === newType) {
    return { changed: false, message: 'אין שינוי בסטטוס' };
  }

  if (isFutureDateKey(dateKey) && newType === 'workout_done') {
    throw new Error('לא ניתן לסמן אימון עתידי. ניתן לסמן רק "לא יהיה אימון" או לנקות.');
  }

  const { balanceDelta, workoutDelta } = computeDailyFinancialDelta(oldType, newType, dateKey);
  const nextBalance = state.balance + balanceDelta;
  const nextWorkouts = Math.max(0, state.totalWorkouts + workoutDelta);

  if (balanceDelta < 0 && nextBalance < 0) {
    const shouldContinue = await new Promise(resolve => {
      showConfirm(
        'מינוס בקופה',
        `הפעולה תגרום למינוס של ₪${formatNum(Math.abs(nextBalance))}. להמשיך?`,
        () => resolve(true),
        () => resolve(false)
      );
    });

    if (!shouldContinue) {
      return { changed: false, cancelled: true, message: 'הפעולה בוטלה' };
    }
  }

  const todayKey = todayDateKey();
  const isRetro = dateKey !== todayKey;
  const reportRef = getDailyReportRef(dateKey);
  const userRef = getUserDocRef();
  const batch = _firebaseDb.batch();

  const nextReport = newType
    ? {
        type: newType,
        isFuture: isFutureDateKey(dateKey),
        source,
        createdAt: oldReport?.createdAt || firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }
    : null;

  if (nextReport) {
    batch.set(reportRef, nextReport, { merge: true });
  } else {
    batch.delete(reportRef);
  }

  batch.set(userRef, {
    balance: nextBalance,
    totalWorkouts: nextWorkouts,
    workoutPrice: state.workoutPrice,
    theme: state.theme,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  const noteParts = [
    `עודכן דרך ${source === 'home' ? 'מסך הבית' : 'קלנדר'}`,
    `שינוי: ${statusLabel(oldType)} -> ${statusLabel(newType)}`
  ];
  if (isRetro) noteParts.push('עדכון רטרואקטיבי');

  const logType = newType || 'status_cleared';
  const logTitle = newType === 'workout_done'
    ? 'סימון יום כאימון'
    : newType === 'no_workout'
      ? 'סימון יום ללא אימון'
      : 'ניקוי סימון יום';

  const logRef = getLogsColRef().doc();
  const logEntry = buildLogEntryForDate({
    dateKey,
    type: logType,
    title: logTitle,
    amount: balanceDelta,
    balanceAfter: nextBalance,
    note: noteParts.join(' | ')
  });
  batch.set(logRef, {
    ...logEntry,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  await batch.commit();

  state.balance = nextBalance;
  state.totalWorkouts = nextWorkouts;
  if (nextReport) {
    state.dailyReportsByDate[dateKey] = {
      ...oldReport,
      ...nextReport,
      docId: dateKey
    };
  } else {
    delete state.dailyReportsByDate[dateKey];
  }
  state.todayReport = state.dailyReportsByDate[todayKey] || null;

  state.logs.unshift({ ...logEntry, id: logRef.id });
  _lastCloudSyncAt = new Date();
  saveToLocalStorage();
  refreshAllUI();

  return {
    changed: true,
    newType,
    dateKey,
    message: newType === 'workout_done'
      ? `${formatDateKeyForDisplay(dateKey)} סומן כאימון`
      : newType === 'no_workout'
        ? `${formatDateKeyForDisplay(dateKey)} סומן ללא אימון`
        : `הוסר סימון עבור ${formatDateKeyForDisplay(dateKey)}`
  };
}

// ============================================================
//  ניווט
// ============================================================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const t = document.getElementById(`screen-${name}`);
  if (t) t.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.screen === name));
  if (name === 'journal') renderJournal();
  if (name === 'summary') renderMonthlySummary();
  if (name === 'settings') renderSettings();
}

function showSubScreen(name, preserveInputs = false) {
  document.querySelectorAll('.sub-screen').forEach(s => {
    s.style.display = 'none'; s.classList.remove('active');
  });
  const t = document.getElementById(`sub-screen-${name}`);
  if (!t) return;
  if (!preserveInputs) {
    t.querySelectorAll('input[type="number"],input[type="text"]').forEach(i => { i.value = ''; });
  }
  t.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('active')));
}

function hideSubScreen() {
  document.querySelectorAll('.sub-screen.active').forEach(s => {
    s.classList.remove('active');
    setTimeout(() => { s.style.display = 'none'; }, 340);
  });
  _editingEntryId = null;
}

function handleSubScreenOverlayClick(e) {
  if (e.target.classList.contains('sub-screen')) hideSubScreen();
}

// ============================================================
//  פעולות אימון יומי (עם בדיקת כפילות)
// ============================================================
function handleWorkout() {
  if (_workoutLocked) return;
  _workoutLocked = true;
  setTimeout(() => { _workoutLocked = false; }, 800);

  if (state.todayReport) {
    if (state.todayReport.type === 'workout_done') {
      showToast('כבר נרשם אימון היום ✓', 'info');
      return;
    }
    showConfirm('עדכון דיווח יומי',
      'כבר נרשם "לא היה אימון" היום. האם לשנות ל"היה אימון"?',
      async () => {
        try {
          const result = await setDailyStatus(todayDateKey(), 'workout_done', 'home');
          if (result.changed) showToast('היום סומן כאימון', 'success');
        } catch (e) {
          showToast(e.message || 'עדכון נכשל', 'error');
        }
      });
    return;
  }

  setDailyStatus(todayDateKey(), 'workout_done', 'home')
    .then(result => {
      if (result.changed) showToast('היום סומן כאימון', 'success');
    })
    .catch(error => {
      showToast(error.message || 'עדכון נכשל', 'error');
    });
}

function skipWorkout() {
  if (_workoutLocked) return;
  _workoutLocked = true;
  setTimeout(() => { _workoutLocked = false; }, 800);

  if (state.todayReport) {
    if (state.todayReport.type === 'no_workout') {
      showToast('כבר נרשם "לא היה אימון" היום', 'info');
      return;
    }
    showConfirm('עדכון דיווח יומי',
      'כבר נרשם אימון היום. האם לשנות ל"לא היה אימון"? הכסף יוחזר.',
      async () => {
        try {
          const result = await setDailyStatus(todayDateKey(), 'no_workout', 'home');
          if (result.changed) showToast('היום סומן ללא אימון', 'success');
        } catch (e) {
          showToast(e.message || 'עדכון נכשל', 'error');
        }
      });
    return;
  }

  setDailyStatus(todayDateKey(), 'no_workout', 'home')
    .then(result => {
      if (result.changed) showToast('היום סומן ללא אימון', 'success');
    })
    .catch(error => {
      showToast(error.message || 'עדכון נכשל', 'error');
    });
}

// ============================================================
//  הוספת כסף
// ============================================================
async function addMoney() {
  const amountInput = document.getElementById('add-money-input');
  const noteInput   = document.getElementById('add-money-note');
  const amount = parseFloat(amountInput.value);
  if (!amount || amount <= 0 || isNaN(amount)) {
    showToast('יש להזין סכום חיובי', 'error'); amountInput.focus(); return;
  }
  try {
    state.balance += amount;
    const entry = buildLogEntry({
      type: 'money_added', title: 'הוספת כסף',
      amount, balanceAfter: state.balance,
      note: noteInput.value.trim()
    });
    state.logs.unshift(entry);
    const id = await addLogToCloud(entry);
    entry.id = id;
    await saveUserDoc();
    updateHomeUI();
    hideSubScreen();
    showToast(`₪${formatNum(amount)} נוספו לקופה 💰`, 'success');
  } catch (e) {
    console.warn('[Fitness] addMoney failed:', e);
    showToast('שמירה לענן נכשלה', 'error');
  }
}

// ============================================================
//  קביעת יתרה
// ============================================================
async function setBalance() {
  const amountInput = document.getElementById('set-balance-input');
  const noteInput   = document.getElementById('set-balance-note');
  const newBalance  = parseFloat(amountInput.value);
  if (isNaN(newBalance)) {
    showToast('יש להזין יתרה תקינה', 'error'); amountInput.focus(); return;
  }
  try {
    const oldBalance = state.balance;
    state.balance = newBalance;
    const entry = buildLogEntry({
      type: 'balance_set', title: 'עדכון יתרה ידני',
      amount: newBalance - oldBalance, balanceAfter: newBalance,
      note: noteInput.value.trim() || `שונה מ-₪${formatNum(oldBalance)} ל-₪${formatNum(newBalance)}`
    });
    state.logs.unshift(entry);
    const id = await addLogToCloud(entry);
    entry.id = id;
    await saveUserDoc();
    updateHomeUI();
    hideSubScreen();
    showToast('היתרה עודכנה ✅', 'success');
  } catch (e) {
    console.warn('[Fitness] setBalance failed:', e);
    showToast('שמירה לענן נכשלה', 'error');
  }
}

// ============================================================
//  עדכון מחיר
// ============================================================
async function updatePrice() {
  const input = document.getElementById('price-input');
  const newPrice = parseFloat(input.value);
  if (!newPrice || newPrice <= 0 || isNaN(newPrice)) {
    showToast('יש להזין מחיר חיובי', 'error'); input.focus(); return;
  }
  try {
    const oldPrice = state.workoutPrice;
    state.workoutPrice = newPrice;
    const entry = buildLogEntry({
      type: 'price_changed', title: 'שינוי מחיר אימון',
      amount: 0, balanceAfter: state.balance,
      note: `מחיר שונה מ-₪${formatNum(oldPrice)} ל-₪${formatNum(newPrice)}`
    });
    state.logs.unshift(entry);
    const id = await addLogToCloud(entry);
    entry.id = id;
    await saveUserDoc();
    updateHomeUI();
    showToast(`מחיר אימון עודכן ל-₪${formatNum(newPrice)}`, 'success');
  } catch (e) {
    console.warn('[Fitness] updatePrice failed:', e);
    showToast('שמירה לענן נכשלה', 'error');
  }
}

// ============================================================
//  Pull-to-Refresh
// ============================================================
async function refreshFromPull() {
  if (_isPullRefreshing) return;
  _isPullRefreshing = true;
  setPullRefreshIndicator('מרענן נתונים...', true);
  try {
    const ok = await hydrateState();
    if (!ok || _lastCloudError) {
      showToast('סנכרון ענן נכשל', 'error');
    } else {
      refreshAllUI();
      showToast('הנתונים עודכנו מהענן', 'success');
    }
  } catch {
    showToast('לא ניתן היה לרענן כעת', 'error');
  } finally {
    _isPullRefreshing = false;
    setPullRefreshIndicator('משוך למטה כדי לרענן', false);
  }
}

function setPullRefreshIndicator(msg, active, ready = false) {
  const el = document.getElementById('pull-refresh-indicator');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('visible',    active || ready);
  el.classList.toggle('ready',      ready);
  el.classList.toggle('refreshing', active);
}

function setupPullToRefresh() {
  const screen = document.getElementById('screen-home');
  if (!screen || screen.dataset.pullReady === 'true') return;
  const s = { startY:0, deltaY:0, dragging:false };
  screen.addEventListener('touchstart', e => {
    if (screen.scrollTop > 0 || e.touches.length !== 1 || _isPullRefreshing) return;
    s.startY = e.touches[0].clientY; s.deltaY = 0; s.dragging = true;
  }, { passive: true });
  screen.addEventListener('touchmove', e => {
    if (!s.dragging || e.touches.length !== 1) return;
    s.deltaY = Math.max(0, e.touches[0].clientY - s.startY);
    if (s.deltaY <= 0 || screen.scrollTop > 0) return;
    const ready = s.deltaY > 70;
    setPullRefreshIndicator(ready ? 'שחרר כדי לרענן' : 'משוך למטה כדי לרענן', true, ready);
    if (s.deltaY > 6) e.preventDefault();
  }, { passive: false });
  screen.addEventListener('touchend', () => {
    if (!s.dragging) return;
    const should = s.deltaY > 70;
    s.dragging = false; s.deltaY = 0;
    if (should) { refreshFromPull(); return; }
    setPullRefreshIndicator('משוך למטה כדי לרענן', false);
  });
  screen.dataset.pullReady = 'true';
}

// ============================================================
//  יומן – רינדור
// ============================================================
function renderJournal() {
  const container = document.getElementById('journal-container');
  if (!container) return;
  if (state.logs.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><h3>היומן עדיין ריק</h3><p>כאן יופיעו כל הפעולות שביצעת</p></div>`;
    return;
  }
  const grouped = {};
  state.logs.forEach(e => {
    const mk = e.monthKey || deriveMonthKey(e.date);
    if (!grouped[mk]) grouped[mk] = [];
    grouped[mk].push(e);
  });
  const sortedMonths = Object.keys(grouped).sort().reverse();
  let html = '';
  sortedMonths.forEach(mk => {
    const [y, m] = mk.split('-');
    const label = new Date(y, Number(m)-1, 1).toLocaleDateString('he-IL', { year:'numeric', month:'long' });
    html += `<div class="log-month-header">${label}</div><div class="log-month-group">`;
    grouped[mk].forEach(e => { html += buildJournalEntryHTML(e); });
    html += `</div>`;
  });
  container.innerHTML = html;
}

const LOG_CONFIG = {
  workout_done:   { icon:'🏋️', color:'red',   label:'אימון'           },
  no_workout:     { icon:'⏭️', color:'gray',  label:'לא היה אימון'    },
  status_cleared: { icon:'🧹', color:'gray',  label:'נוקה סימון'       },
  money_added:    { icon:'💰', color:'green', label:'הוספת כסף'       },
  balance_set:    { icon:'✏️', color:'blue',  label:'עדכון יתרה'      },
  price_changed:  { icon:'🏷️', color:'blue',  label:'שינוי מחיר'      },
  journal_edited: { icon:'🧾', color:'gray',  label:'עריכת יומן'      },
  journal_deleted:{ icon:'🗑️', color:'gray',  label:'מחיקת יומן'     },
};

function buildJournalEntryHTML(entry) {
  const cfg = LOG_CONFIG[entry.type] || { icon:'📝', color:'gray', label: entry.type };
  const amountHTML = entry.amount !== 0
    ? `<span class="amount ${entry.amount > 0 ? 'positive' : 'negative'}">${entry.amount > 0 ? '+' : ''}₪${formatNum(Math.abs(entry.amount))}</span>`
    : '';
  const noteHTML = entry.note ? `<div class="log-note">${escapeHTML(entry.note)}</div>` : '';
  const dtHTML   = `<div class="log-entry-datetime" dir="rtl"><span>${entry.date}</span><span>${entry.time}</span></div>`;
  const editBtn  = `<button class="journal-edit-btn" type="button"
    data-entry-id="${escapeHTML(entry.id)}"
    data-entry-title="${escapeHTML(entry.title)}"
    data-entry-amount="${entry.amount}"
    data-entry-note="${escapeHTML(entry.note||'')}"
    onclick="openEditEntryFromButton(this)">עריכה</button>`;
  return `<div class="log-entry">
    <div class="log-entry-icon log-icon-${cfg.color}">${cfg.icon}</div>
    <div class="log-entry-body">
      <div class="log-entry-title">${escapeHTML(entry.title)}</div>
      <div class="log-entry-meta">${dtHTML}${noteHTML}</div>
      <div class="journal-entry-actions">${editBtn}</div>
    </div>
    <div class="log-entry-amounts">${amountHTML}<div class="log-balance-after">₪${formatNum(entry.balanceAfter)}</div></div>
  </div>`;
}

// ============================================================
//  סיכום חודשי
// ============================================================
function renderMonthlySummary() {
  const container = document.getElementById('monthly-summary-container');
  if (!container) return;
  const monthDate = _calendarViewDate instanceof Date ? _calendarViewDate : startOfMonth(new Date());
  const monthKey = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
  const currentMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const monthLabel = monthDate.toLocaleDateString('he-IL', { year:'numeric', month:'long' });

  const dayCells = buildCalendarDayCells(monthDate).map(day => {
    if (!day.dateKey) {
      return '<div class="calendar-day empty"></div>';
    }

    const report = state.dailyReportsByDate[day.dateKey] || null;
    const statusClass = report?.type === 'workout_done'
      ? 'workout'
      : report?.type === 'no_workout'
        ? 'no-workout'
        : 'none';

    const selectedClass = _selectedCalendarDateKey === day.dateKey ? 'selected' : '';
    const todayClass = day.isToday ? 'today' : '';
    const futureClass = day.isFuture ? 'future' : '';
    const isFilteredOut = _calendarFilter === 'workout'
      ? report?.type !== 'workout_done'
      : _calendarFilter === 'no-workout'
        ? report?.type !== 'no_workout'
        : false;
    const filterClass = isFilteredOut ? 'filtered-out' : '';

    return `
      <button
        type="button"
        class="calendar-day ${statusClass} ${selectedClass} ${todayClass} ${futureClass} ${filterClass}"
        onclick="selectCalendarDate('${day.dateKey}')"
        aria-label="${formatDateKeyForDisplay(day.dateKey)} - ${statusLabel(report?.type)}">
        <span class="calendar-day-number">${day.dayNumber}</span>
      </button>`;
  }).join('');

  const selectedDateKey = _selectedCalendarDateKey || (monthKey === currentMonthKey
    ? todayDateKey()
    : `${monthKey}-01`);
  const selectedReport = state.dailyReportsByDate[selectedDateKey] || null;
  const selectedFuture = isFutureDateKey(selectedDateKey);
  const actionHint = selectedFuture
    ? 'יום עתידי: ניתן לסמן רק "לא יהיה אימון" או לנקות סימון'
    : 'יום עבר/היום: שינוי סטטוס יעדכן גם יתרה ומספר שיעורים';

  const summaries = buildMonthlySummaries();
  const statsHtml = summaries.length
    ? summaries.map(summary => {
        const isCurrent = summary.monthKey === monthKey;
        const netClass = summary.net >= 0 ? 'positive' : 'negative';
        const endBalanceText = summary.endBalance == null
          ? '—'
          : `₪${formatNum(summary.endBalance)}`;
        return `
          <div class="summary-month-card${isCurrent ? ' current' : ''}">
            <div class="summary-month-header-row">
              <div class="summary-month-title">${escapeHTML(summary.label)}</div>
              <div class="summary-month-badge">${isCurrent ? 'החודש' : 'סיכום'}</div>
            </div>
            <div class="summary-insights-row">
              <div class="summary-insight">דיווח חודשי: <strong>${summary.reportedDays}/${summary.daysInMonth}</strong></div>
              <div class="summary-insight">כיסוי: <strong>${summary.completionRate}%</strong></div>
            </div>
            <div class="summary-grid">
              <div class="summary-stat"><div class="summary-stat-value">${summary.workoutDays}</div><div class="summary-stat-label">ימי אימון</div></div>
              <div class="summary-stat"><div class="summary-stat-value">${summary.noWorkoutDays}</div><div class="summary-stat-label">ימים ללא אימון</div></div>
              <div class="summary-stat"><div class="summary-stat-value">₪${formatNum(summary.added)}</div><div class="summary-stat-label">כסף שנוסף</div></div>
              <div class="summary-stat"><div class="summary-stat-value">₪${formatNum(summary.spent)}</div><div class="summary-stat-label">כסף שירד</div></div>
              <div class="summary-stat"><div class="summary-stat-value ${netClass}">${summary.net >= 0 ? '+' : ''}₪${formatNum(summary.net)}</div><div class="summary-stat-label">מאזן חודשי</div></div>
              <div class="summary-stat"><div class="summary-stat-value">${endBalanceText}</div><div class="summary-stat-label">יתרה בסוף חודש</div></div>
            </div>
          </div>`;
      }).join('')
    : `<div class="empty-state"><div class="empty-icon">📆</div><h3>אין עדיין נתונים חודשיים</h3></div>`;

  container.innerHTML = `
    <div class="calendar-card">
      <div class="calendar-header">
        <button type="button" class="calendar-nav-btn" onclick="changeCalendarMonth(-1)" aria-label="חודש קודם">◀</button>
        <div class="calendar-title">${escapeHTML(monthLabel)}</div>
        <button type="button" class="calendar-nav-btn" onclick="changeCalendarMonth(1)" aria-label="חודש הבא">▶</button>
      </div>
      <div class="calendar-toolbar">
        <button type="button" class="calendar-today-btn" onclick="goToTodayInCalendar()">חזור להיום</button>
        <div class="calendar-filters" role="group" aria-label="סינון ימים">
          <button type="button" class="calendar-filter-btn ${_calendarFilter === 'all' ? 'active' : ''}" onclick="setCalendarFilter('all')">הכול</button>
          <button type="button" class="calendar-filter-btn ${_calendarFilter === 'workout' ? 'active' : ''}" onclick="setCalendarFilter('workout')">רק אימונים</button>
          <button type="button" class="calendar-filter-btn ${_calendarFilter === 'no-workout' ? 'active' : ''}" onclick="setCalendarFilter('no-workout')">רק ללא אימון</button>
        </div>
      </div>
      <div class="calendar-weekdays">
        <span>א</span><span>ב</span><span>ג</span><span>ד</span><span>ה</span><span>ו</span><span>ש</span>
      </div>
      <div class="calendar-grid">${dayCells}</div>
    </div>

    <div class="calendar-actions-card">
      <div class="calendar-actions-title">${formatDateKeyForDisplay(selectedDateKey)}</div>
      <div class="calendar-actions-status">סטטוס נוכחי: <strong>${statusLabel(selectedReport?.type)}</strong></div>
      <div class="calendar-actions-hint">${actionHint}</div>
      <div class="calendar-actions-row">
        <button type="button" class="btn btn-primary btn-sm" ${selectedFuture ? 'disabled' : ''} onclick="setCalendarDayStatus('workout_done')">היה אימון</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="setCalendarDayStatus('no_workout')">לא היה אימון</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="setCalendarDayStatus('clear')">נקה סימון</button>
      </div>
    </div>

    <div class="summary-section-title">סטטיסטיקות קיימות</div>
    ${statsHtml}
  `;
}

function buildCalendarDayCells(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const cells = [];

  const leadingBlanks = firstDay.getDay();
  for (let i = 0; i < leadingBlanks; i += 1) {
    cells.push({ dateKey: '', dayNumber: '', isToday: false, isFuture: false });
  }

  for (let day = 1; day <= lastDay.getDate(); day += 1) {
    const date = new Date(year, month, day);
    const dateKey = dateKeyFromDate(date);
    const isToday = dateKey === todayDateKey();
    const isFuture = isFutureDateKey(dateKey);
    cells.push({ dateKey, dayNumber: day, isToday, isFuture });
  }

  while (cells.length % 7 !== 0) {
    cells.push({ dateKey: '', dayNumber: '', isToday: false, isFuture: false });
  }

  return cells;
}

function changeCalendarMonth(delta) {
  _calendarViewDate = new Date(_calendarViewDate.getFullYear(), _calendarViewDate.getMonth() + delta, 1);
  _selectedCalendarDateKey = '';
  renderMonthlySummary();
}

function selectCalendarDate(dateKey) {
  if (!dateKey) return;
  _selectedCalendarDateKey = dateKey;
  renderMonthlySummary();
}

function goToTodayInCalendar() {
  const today = new Date();
  _calendarViewDate = startOfMonth(today);
  _selectedCalendarDateKey = todayDateKey();
  renderMonthlySummary();
}

function setCalendarFilter(filter) {
  _calendarFilter = ['all', 'workout', 'no-workout'].includes(filter) ? filter : 'all';
  renderMonthlySummary();
}

async function setCalendarDayStatus(status) {
  const dateKey = _selectedCalendarDateKey || todayDateKey();
  const normalized = status === 'clear' ? null : status;

  try {
    const result = await setDailyStatus(dateKey, normalized, 'calendar');
    if (result?.changed) {
      showToast(result.message, 'success');
    } else if (result?.cancelled) {
      showToast('הפעולה בוטלה', 'info');
    } else {
      showToast(result?.message || 'אין שינוי', 'info');
    }
  } catch (error) {
    showToast(error.message || 'עדכון קלנדר נכשל', 'error');
  }

  renderMonthlySummary();
}

function buildMonthlySummaries() {
  const grouped = new Map();
  const ensureSummary = mk => {
    if (!grouped.has(mk)) {
      const [y, m] = mk.split('-');
      const daysInMonth = new Date(Number(y), Number(m), 0).getDate();
      grouped.set(mk, {
        monthKey: mk,
        label: new Date(Number(y), Number(m)-1, 1).toLocaleDateString('he-IL', { year:'numeric', month:'long' }),
        daysInMonth,
        workoutDays: 0,
        noWorkoutDays: 0,
        spent: 0,
        added: 0,
        endBalance: null,
        net: 0,
        reportedDays: 0,
        completionRate: 0
      });
    }
    return grouped.get(mk);
  };

  state.logs.forEach(entry => {
    const mk = entry.monthKey || deriveMonthKey(entry.date);
    const t = ensureSummary(mk);
    if ((Number(entry.amount)||0) > 0) {
      t.added += Number(entry.amount)||0;
    }

    const sortValue = getLogSortValue(entry);
    const currentSortValue = t._endBalanceSortValue || 0;
    if (sortValue >= currentSortValue && Number.isFinite(Number(entry.balanceAfter))) {
      t.endBalance = Number(entry.balanceAfter);
      t._endBalanceSortValue = sortValue;
    }
  });

  Object.entries(state.dailyReportsByDate || {}).forEach(([dateKey, report]) => {
    if (!report || !report.type) return;
    const [year, month] = dateKey.split('-');
    const mk = `${year}-${month}`;
    const t = ensureSummary(mk);

    if (report.type === 'workout_done') {
      t.workoutDays += 1;
      t.spent += state.workoutPrice;
    }
    if (report.type === 'no_workout') {
      t.noWorkoutDays += 1;
    }
  });

  grouped.forEach(summary => {
    summary.reportedDays = summary.workoutDays + summary.noWorkoutDays;
    summary.net = summary.added - summary.spent;
    summary.completionRate = summary.daysInMonth > 0
      ? Math.round((summary.reportedDays / summary.daysInMonth) * 100)
      : 0;

    delete summary._endBalanceSortValue;
  });

  return Array.from(grouped.values()).sort((a,b) => b.monthKey.localeCompare(a.monthKey));
}

function deriveMonthKey(dateStr) {
  if (typeof dateStr !== 'string') {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
  }
  const parts = dateStr.split(/[./-]/).map(p => p.trim());
  if (parts.length !== 3) {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
  }
  const [day, month, year] = parts;
  return `${year}-${String(month).padStart(2,'0')}`;
}

// ============================================================
//  עריכה / מחיקה ביומן
// ============================================================
function openEditEntryFromButton(btn) {
  openEditEntry(btn.dataset.entryId, btn.dataset.entryTitle||'', Number(btn.dataset.entryAmount)||0, btn.dataset.entryNote||'');
}

function openEditEntry(id, title, amount, note) {
  const entry = state.logs.find(l => l.id === id);
  if (!entry) return;
  _editingEntryId = id;
  document.getElementById('edit-entry-title').value  = title  || entry.title  || '';
  const amtInput = document.getElementById('edit-entry-amount');
  amtInput.value    = Number.isFinite(amount) ? amount : (Number(entry.amount)||0);
  amtInput.disabled = isZeroAmountEntry(entry);
  document.getElementById('edit-entry-note').value   = note   || entry.note   || '';
  showSubScreen('edit-entry', true);
}

function saveEditedEntry() {
  if (!_editingEntryId) return;
  const entry = state.logs.find(l => l.id === _editingEntryId);
  if (!entry) return;
  const newTitle  = document.getElementById('edit-entry-title').value.trim();
  const amtInput  = document.getElementById('edit-entry-amount');
  const rawAmount = parseFloat(amtInput.value);
  const newAmount = amtInput.disabled ? Number(entry.amount)||0 : normalizeEntryAmount(entry.type, rawAmount);
  const newNote   = document.getElementById('edit-entry-note').value.trim();
  if (!newTitle || Number.isNaN(newAmount)) { showToast('יש למלא כותרת וסכום תקין', 'error'); return; }

  const before = { title: entry.title, amount: entry.amount, note: entry.note };
  entry.title = newTitle; entry.amount = newAmount; entry.note = newNote;
  recalculateFromLogs();

  const audit = buildLogEntry({ type:'journal_edited', title:'נערכה רשומה', amount:0, balanceAfter:state.balance, note:`"${before.title}" עודכנה` });
  state.logs.unshift(audit);
  updateLogInCloud(entry.id, { title:entry.title, amount:entry.amount, note:entry.note, balanceAfter:entry.balanceAfter });
  addLogToCloud(audit).then(id => { audit.id = id; });
  recalculateFromLogs();
  saveUserDoc();
  refreshAllUI();
  hideSubScreen();
  showToast('הרשומה עודכנה', 'success');
}

function deleteEditedEntry() {
  if (!_editingEntryId) return;
  const entry = state.logs.find(l => l.id === _editingEntryId);
  if (!entry) return;
  showConfirm('מחיקת רשומה', 'הרשומה תימחק מהיומן. האם להמשיך?', async () => {
    const removed = { ...entry };
    state.logs = state.logs.filter(l => l.id !== _editingEntryId);
    recalculateFromLogs();
    const audit = buildLogEntry({ type:'journal_deleted', title:'נמחקה רשומה', amount:0, balanceAfter:state.balance, note:`נמחקה: "${removed.title}"` });
    state.logs.unshift(audit);
    await deleteLogFromCloud(removed.id);
    await addLogToCloud(audit).then(id => { audit.id = id; });
    recalculateFromLogs();
    await saveUserDoc();
    refreshAllUI();
    hideSubScreen();
    showToast('הרשומה נמחקה', 'warning');
  });
}

function isZeroAmountEntry(entry) {
  return ['journal_edited','journal_deleted','price_changed','no_workout'].includes(entry.type) ||
    (Number(entry.amount)||0) === 0;
}

function normalizeEntryAmount(type, amount) {
  if (Number.isNaN(amount)) return amount;
  if (type === 'workout_done') return -Math.abs(amount);
  if (type === 'money_added')  return  Math.abs(amount);
  return amount;
}

function recalculateFromLogs() {
  let balance = 0; let workouts = 0;
  [...state.logs].reverse().forEach(e => {
    e.monthKey = deriveMonthKey(e.date);
    balance   += Number(e.amount)||0;
    e.balanceAfter = balance;
    if (e.type === 'workout_done') workouts++;
  });
  state.balance      = balance;
  state.totalWorkouts = workouts;
}

// ============================================================
//  הגדרות – רינדור
// ============================================================
function renderSettings() {
  const priceInput  = document.getElementById('price-input');
  const themeToggle = document.getElementById('theme-toggle');
  if (priceInput)  priceInput.value   = state.workoutPrice;
  if (themeToggle) themeToggle.checked = (state.theme || 'light') === 'dark';
  const iosNotice = document.getElementById('ios-pwa-notice');
  if (iosNotice) iosNotice.style.display = isIOS() ? 'block' : 'none';
  updateCloudSyncStatus();
  updateDebugPanel();
}

// ============================================================
//  ערכת נושא
// ============================================================
function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  state.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.setAttribute('content', THEME_META_COLORS[t]);
}

function toggleThemeSetting() {
  const toggle = document.getElementById('theme-toggle');
  const next   = toggle?.checked ? 'dark' : 'light';
  applyTheme(next);
  saveUserDoc();
  showToast(next === 'dark' ? 'מצב לילה הופעל' : 'מצב בהיר הופעל', 'success');
}

// ============================================================
//  עדכון מסך בית
// ============================================================
function updateHomeUI() {
  const balDisp = document.getElementById('balance-display');
  const balMeta = document.getElementById('balance-meta');
  const totalEl = document.getElementById('total-workouts-display');
  const remEl   = document.getElementById('remaining-workouts-display');
  const sumEl   = document.getElementById('summary-text');
  const todayEl = document.getElementById('today-report-status');
  if (!balDisp) return;

  const { balance, workoutPrice: price, totalWorkouts: wc } = state;
  const remaining = price > 0 ? Math.floor(balance / price) : 0;

  balDisp.textContent = `₪${formatNum(balance)}`;
  balDisp.className   = `balance-amount${balance < 0 ? ' negative' : ''}`;

  if (balance < 0) {
    balMeta.textContent = `מינוס של ₪${formatNum(Math.abs(balance))}`;
    balMeta.className   = 'balance-meta negative';
  } else if (balance === 0) {
    balMeta.textContent = 'הקופה ריקה';
    balMeta.className   = 'balance-meta';
  } else {
    balMeta.textContent = `מחיר אימון: ₪${formatNum(price)}`;
    balMeta.className   = 'balance-meta';
  }

  if (totalEl) totalEl.textContent = wc;
  if (remEl)   remEl.textContent   = remaining > 0 ? remaining : 0;

  if (sumEl) {
    if (balance <= 0) {
      sumEl.textContent = 'יש להוסיף כסף לקופה כדי לרשום אימונים';
      sumEl.className   = 'summary-card warning';
    } else if (remaining <= 1) {
      sumEl.textContent = remaining === 1 ? 'נשאר אימון אחד בקופה – כדאי לחדש' : 'הוסף כסף לקופה לאימון הבא';
      sumEl.className   = 'summary-card warning';
    } else {
      sumEl.textContent = `ביצעת ${wc} אימונים. נשארו ${remaining} אימונים ביתרה.`;
      sumEl.className   = 'summary-card';
    }
  }

  if (todayEl) {
    if (!state.todayReport) {
      todayEl.textContent = 'היום עדיין לא דווח';
      todayEl.className   = 'today-report-status today-none';
    } else if (state.todayReport.type === 'workout_done') {
      todayEl.textContent = 'היום דווח: היה אימון ✓';
      todayEl.className   = 'today-report-status today-workout';
    } else {
      todayEl.textContent = 'היום דווח: לא היה אימון';
      todayEl.className   = 'today-report-status today-skip';
    }
  }
}

function updateCloudSyncStatus(msg) {
  const el = document.getElementById('cloud-sync-status');
  if (!el) return;
  if (msg) { el.textContent = msg; updateDebugPanel(); return; }
  if (!_cloudReady) {
    el.textContent = _cloudInitError ? `ענן: לא מחובר (${_cloudInitError})` : 'ענן: לא מחובר';
    updateDebugPanel();
    return;
  }
  if (_isHydrating) {
    el.textContent = 'טוען נתונים מהענן...';
    updateDebugPanel();
    return;
  }
  if (_lastCloudError) {
    el.textContent = `שגיאת ענן: ${_lastCloudError}`;
    updateDebugPanel();
    return;
  }
  if (_realtimeReady) {
    el.textContent = 'סנכרון חי פעיל בין מכשירים ✓';
    updateDebugPanel();
    return;
  }
  if (_lastCloudSyncAt instanceof Date && !isNaN(_lastCloudSyncAt)) {
    el.textContent = `סנכרון אחרון: ${formatDateTime(_lastCloudSyncAt)}`;
    updateDebugPanel();
    return;
  }
  el.textContent = 'מחובר לענן ✓';
  updateDebugPanel();
}

function setDebugValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = String(value);
}

function updateDebugPanel() {
  setDebugValue('debug-cloud-ready', _cloudReady ? 'true' : 'false');
  setDebugValue('debug-hydrating', _isHydrating ? 'true' : 'false');
  setDebugValue('debug-realtime-ready', _realtimeReady ? 'true' : 'false');
  setDebugValue('debug-profile-id', SHARED_PROFILE_ID);
  setDebugValue('debug-last-sync', _lastCloudSyncAt ? formatDateTime(_lastCloudSyncAt) : '-');
  setDebugValue('debug-last-error', _lastCloudError || '-');
  setDebugValue('debug-logs-count', Array.isArray(state.logs) ? state.logs.length : 0);
  setDebugValue('debug-today-report', state.todayReport?.type || 'none');
  setDebugValue('debug-online', navigator.onLine ? 'true' : 'false');
  setDebugValue('debug-user-agent', navigator.userAgent || '-');
}

function refreshAllUI() {
  updateHomeUI();
  renderJournal();
  renderMonthlySummary();
  renderSettings();
  applyTheme(state.theme || 'light');
}

// ============================================================
//  ייצוא / ייבוא
// ============================================================
function exportData() {
  const date  = new Date().toISOString().split('T')[0];
  const lines = [
    '===== גיבוי כושר =====', `תאריך: ${date}`, '',
    `יתרה: ₪${formatNum(state.balance)}`,
    `מחיר אימון: ₪${formatNum(state.workoutPrice)}`,
    `סה"כ אימונים: ${state.totalWorkouts}`, '',
    '===== לוג פעולות ====='
  ];
  state.logs.forEach(e => {
    const a = e.amount !== 0 ? ` | ${e.amount > 0 ? '+' : ''}₪${formatNum(e.amount)}` : '';
    const n = e.note ? ` | ${e.note}` : '';
    lines.push(`${e.date} ${e.time} | ${e.title}${a} | יתרה: ₪${formatNum(e.balanceAfter)}${n}`);
  });
  lines.push('', '===== נתונים גולמיים =====', JSON.stringify(state));
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `fitness-backup-${date}.txt` });
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast('גיבוי יוצא בהצלחה 📤', 'success');
}

function triggerImport() { document.getElementById('import-file-input').click(); }

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const rawLine = e.target.result.split('\n').find(l => l.trim().startsWith('{'));
      if (!rawLine) { showToast('קובץ גיבוי לא תקין', 'error'); return; }
      const imp = JSON.parse(rawLine.trim());
      if (typeof imp.balance !== 'number' || !Array.isArray(imp.logs)) {
        showToast('קובץ גיבוי לא תקין', 'error'); return;
      }
      state = {
        balance:      imp.balance      || 0,
        workoutPrice: imp.workoutPrice || 80,
        totalWorkouts:imp.totalWorkouts|| 0,
        logs:         imp.logs         || [],
        theme:        imp.theme        || 'light',
        todayReport:  imp.todayReport  || null
      };
      recalculateFromLogs();
      applyTheme(state.theme);
      saveUserDoc();
      refreshAllUI();
      showToast('גיבוי יובא בהצלחה 📥', 'success');
    } catch { showToast('שגיאה בייבוא הגיבוי', 'error'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ============================================================
//  איפוס
// ============================================================
function resetData() {
  showConfirm('איפוס נתונים', 'כל הנתונים יימחקו לצמיתות. האם להמשיך?', async () => {
    try {
      await initFirebaseCloud();
      await resetCloudData();

      state = { balance:0, workoutPrice:80, totalWorkouts:0, logs:[], theme:'light', todayReport:null };
      applyTheme(state.theme);
      refreshAllUI();
      showScreen('home');
      updateCloudSyncStatus('הנתונים אופסו בענן');
      showToast('כל הנתונים אופסו', 'warning');
    } catch (e) {
      console.warn('[Fitness] resetData failed:', e);
      showToast('איפוס הנתונים נכשל', 'error');
    }
  });
}

// ============================================================
//  Toast
// ============================================================
let _toastTimer;
function showToast(message, type = 'success') {
  const t = document.getElementById('toast');
  if (!t) return;
  clearTimeout(_toastTimer);
  t.textContent = message;
  t.className   = `toast toast-${type} show`;
  _toastTimer   = setTimeout(() => t.classList.remove('show'), 3200);
}

// ============================================================
//  Confirm dialog
// ============================================================
let _confirmOkCb = null, _confirmCancelCb = null;

function showConfirm(title, message, onOk, onCancel) {
  const overlay = document.getElementById('confirm-overlay');
  if (!overlay) { if (confirm(`${title}\n${message}`)) { if (onOk) onOk(); } return; }
  document.getElementById('confirm-title').textContent   = title;
  document.getElementById('confirm-message').textContent = message;
  _confirmOkCb = onOk || null; _confirmCancelCb = onCancel || null;
  overlay.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('show')));
}

function confirmOk() {
  _closeConfirm();
  const cb = _confirmOkCb; _confirmOkCb = null;
  if (cb) cb();
}

function confirmCancel() {
  _closeConfirm();
  const cb = _confirmCancelCb; _confirmCancelCb = null;
  if (cb) cb();
  _workoutLocked = false;
}

function _closeConfirm() {
  const o = document.getElementById('confirm-overlay');
  if (!o) return;
  o.classList.remove('show');
  setTimeout(() => { o.style.display = 'none'; }, 280);
}

// ============================================================
//  Apple touch icon
// ============================================================
function generateCanvasIcon(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = size * 0.22;
  ctx.fillStyle = '#007AFF';
  ctx.beginPath();
  _roundRectPath(ctx, 0, 0, size, size, r);
  ctx.fill();
  ctx.fillStyle = 'white';
  const s = size / 100;
  _fillRoundRect(ctx,  4*s, 38*s,  6*s, 24*s, 3*s);
  _fillRoundRect(ctx, 10*s, 33*s, 14*s, 34*s, 4*s);
  _fillRoundRect(ctx, 24*s, 44*s, 52*s, 12*s, 3*s);
  _fillRoundRect(ctx, 76*s, 33*s, 14*s, 34*s, 4*s);
  _fillRoundRect(ctx, 90*s, 38*s,  6*s, 24*s, 3*s);
  return canvas.toDataURL('image/png');
}

function _roundRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

function _fillRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); _roundRectPath(ctx, x, y, w, h, r); ctx.fill();
}

// ============================================================
//  Service Worker
// ============================================================
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;

  if (isIOS()) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(reg => reg.unregister()));
      console.log('[Fitness] iOS SW disabled to avoid stale cache issues');
    } catch (e) {
      console.warn('[Fitness] iOS SW cleanup failed:', e);
    }
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    console.log('[Fitness] SW registered:', reg.scope);
    return reg;
  } catch (e) {
    console.warn('[Fitness] SW registration failed:', e);
    return null;
  }
}

// ============================================================
//  מקשי Enter
// ============================================================
function setupKeyboardHandlers() {
  [
    ['add-money-input',  addMoney],
    ['add-money-note',   addMoney],
    ['set-balance-input',setBalance],
    ['set-balance-note', setBalance],
    ['edit-entry-title', saveEditedEntry],
    ['edit-entry-amount',saveEditedEntry],
    ['edit-entry-note',  saveEditedEntry],
  ].forEach(([id, fn]) => {
    document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') fn(); });
  });
}

// ============================================================
//  אתחול
// ============================================================
async function init() {
  await hydrateState();
  applyTheme(state.theme || 'light');
  refreshAllUI();
  updateDebugPanel();

  try {
    const iconURL = generateCanvasIcon(192);
    const link = document.getElementById('apple-touch-icon');
    if (link) link.href = iconURL;
  } catch (e) { /* ignore */ }

  await registerServiceWorker();
  setupKeyboardHandlers();
  setupPullToRefresh();

  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && !_realtimeReady) {
      await hydrateState();
      refreshAllUI();
    }
    updateDebugPanel();
  });

  window.addEventListener('focus', async () => {
    if (!_realtimeReady) {
      await hydrateState();
      refreshAllUI();
    }
    updateDebugPanel();
  });

  window.addEventListener('online', updateDebugPanel);
  window.addEventListener('offline', updateDebugPanel);
}

document.addEventListener('DOMContentLoaded', init);
