'use strict';

// ============================================================
//  קבועים ומפתח localStorage
// ============================================================
const STORAGE_KEY = 'fitness-tracker-v1';
const FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;

const DEFAULT_STATE = {
  balance: 0,
  workoutPrice: 80,
  reminderTime: '09:00',
  notificationsEnabled: false,
  theme: 'light',
  totalWorkouts: 0,
  logs: [],
  lastReminderAt: null,
  lastReminderDateKey: ''
};

// ============================================================
//  ניהול state
// ============================================================
let state = { ...DEFAULT_STATE };
let _cloudReady = false;
let _firebaseDb = null;
let _firebaseUid = null;
let _lastCloudSyncAt = null;
let _cloudInitError = '';
let _editingEntryId = null;
let _isPullRefreshing = false;

const THEME_META_COLORS = {
  light: '#007AFF',
  dark: '#0F172A'
};

/** טוען את המצב מה-localStorage, ממזג עם ברירות מחדל */
function loadState() {
  return loadStateFromLocalStorage();
}

function hasUsableFirebaseConfig() {
  if (!FIREBASE_CONFIG || typeof FIREBASE_CONFIG !== 'object') return false;

  const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
  return required.every(key => {
    const value = FIREBASE_CONFIG[key];
    return typeof value === 'string' && value.trim() && !value.includes('REPLACE_');
  });
}

async function initFirebaseCloud() {
  if (_cloudReady) return true;
  if (!window.firebase) {
    _cloudInitError = 'Firebase SDK לא נטען (ייתכן חסימת רשת ארגונית)';
    return false;
  }
  if (!hasUsableFirebaseConfig()) {
    _cloudInitError = 'הגדרת Firebase חסרה או לא תקינה';
    return false;
  }

  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }

    const auth = firebase.auth();
    if (!auth.currentUser) {
      await auth.signInAnonymously();
    }

    _firebaseDb = firebase.firestore();
    _firebaseUid = auth.currentUser && auth.currentUser.uid;
    _cloudReady = Boolean(_firebaseDb && _firebaseUid);
    _cloudInitError = '';
    return _cloudReady;
  } catch (e) {
    console.warn('[FitnessTracker] Firebase init failed:', e);
    _cloudReady = false;
    _cloudInitError = formatCloudError(e);
    return false;
  }
}

function formatCloudError(error) {
  const raw = (error && (error.code || error.message)) ? `${error.code || ''} ${error.message || ''}` : '';

  if (/api-key|api key|referrer|auth\/invalid-api-key/i.test(raw)) {
    return 'מפתח Firebase חסום לדומיין הנוכחי (בדוק API key restrictions)';
  }
  if (/network|failed to fetch|offline/i.test(raw)) {
    return 'אין גישה לשירותי Firebase מהרשת הנוכחית';
  }
  if (/auth\/operation-not-allowed/i.test(raw)) {
    return 'Anonymous Sign-in כבוי ב-Firebase Authentication';
  }
  if (/auth\/configuration-not-found|configuration-not-found/i.test(raw)) {
    return 'Firebase Authentication לא הוגדר בפרויקט (יש להפעיל Authentication + Anonymous)';
  }

  return 'שגיאה בהתחברות לענן';
}

function getCloudDocRef() {
  if (!_cloudReady || !_firebaseDb || !_firebaseUid) {
    throw new Error('Firebase cloud is not ready');
  }
  return _firebaseDb.collection('fitnessStates').doc(_firebaseUid);
}

function loadStateFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // ממזג עם ברירות מחדל כדי לתמוך בשדות חדשים
      return { ...DEFAULT_STATE, ...parsed };
    }
  } catch (e) {
    console.error('[FitnessTracker] loadState failed:', e);
  }
  return { ...DEFAULT_STATE };
}

/** שומר את המצב הנוכחי ב-localStorage */
function saveStateToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('[FitnessTracker] saveState failed:', e);
    showToast('שגיאה בשמירת הנתונים', 'error');
  }
}

async function loadStateFromCloud() {
  const ref = getCloudDocRef();
  const snap = await ref.get();

  if (!snap.exists) {
    return null;
  }

  const payload = snap.data();
  if (!payload || typeof payload !== 'object' || !payload.state) {
    return null;
  }

  const updatedAt = payload.updatedAt && typeof payload.updatedAt.toDate === 'function'
    ? payload.updatedAt.toDate()
    : null;

  return {
    state: { ...DEFAULT_STATE, ...payload.state },
    updatedAt
  };
}

async function saveState() {
  // שמירה מיידית ל-localStorage כגיבוי, ואז sync לענן
  saveStateToLocalStorage();

  try {
    const cloudOk = await initFirebaseCloud();
    if (!cloudOk) {
      return;
    }

    const ref = getCloudDocRef();
    await ref.set(
      {
        state,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    _lastCloudSyncAt = new Date();
    updateCloudSyncStatus();
  } catch (e) {
    console.warn('[FitnessTracker] saveState cloud sync failed:', e);
    updateCloudSyncStatus('שגיאת סנכרון לענן (הנתונים נשמרו מקומית)');
  }
}

async function hydrateState() {
  const localState = loadStateFromLocalStorage();
  state = localState;

  try {
    const cloudOk = await initFirebaseCloud();
    if (!cloudOk) {
      updateCloudSyncStatus('עובד במצב מקומי בלבד (אין חיבור לענן)');
      return;
    }

    const cloudPayload = await loadStateFromCloud();
    if (cloudPayload) {
      state = cloudPayload.state;
      _lastCloudSyncAt = cloudPayload.updatedAt;
      saveStateToLocalStorage();
      updateCloudSyncStatus();
      return;
    }

    // מסנכרן לענן את ה-state המקומי הקיים בהרצה ראשונה
    await saveState();
  } catch (e) {
    console.warn('[FitnessTracker] using local state (cloud unavailable):', e);
    updateCloudSyncStatus('עובד במצב מקומי בלבד (אין חיבור לענן)');
  }
}

function updateCloudSyncStatus(message) {
  const el = document.getElementById('cloud-sync-status');
  if (!el) return;

  if (message) {
    el.textContent = message;
    return;
  }

  if (!_cloudReady) {
    el.textContent = _cloudInitError ? `ענן: לא מחובר (${_cloudInitError})` : 'ענן: לא מחובר';
    return;
  }

  if (_lastCloudSyncAt instanceof Date && !isNaN(_lastCloudSyncAt)) {
    el.textContent = `סנכרון אחרון לענן: ${formatDateTime(_lastCloudSyncAt)}`;
    return;
  }

  el.textContent = 'סנכרון לענן פעיל';
}

// ============================================================
//  ניווט בין מסכים
// ============================================================

/** מציג מסך לפי שם (home / log / settings) */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(`screen-${name}`);
  if (target) target.classList.add('active');

  // עדכון ניווט תחתון
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.screen === name);
  });

  // רינדור תוכן מסך-ספציפי
  if (name === 'journal') renderJournal();
  if (name === 'summary') renderMonthlySummary();
  if (name === 'settings') renderSettings();
}

/** מציג bottom-sheet (add-money / set-balance / edit-entry) */
function showSubScreen(name, preserveInputs = false) {
  // סגור כל bottom-sheet פתוח
  document.querySelectorAll('.sub-screen').forEach(s => {
    s.style.display = 'none';
    s.classList.remove('active');
  });

  const target = document.getElementById(`sub-screen-${name}`);
  if (!target) return;

  if (!preserveInputs) {
    target.querySelectorAll('input[type="number"], input[type="text"]').forEach(inp => {
      inp.value = '';
    });
  }

  target.style.display = 'flex';
  // עיכוב קטן כדי שה-CSS transition ירוץ
  requestAnimationFrame(() => {
    requestAnimationFrame(() => target.classList.add('active'));
  });
}

/** מסתיר bottom-sheet פעיל */
function hideSubScreen() {
  document.querySelectorAll('.sub-screen.active').forEach(s => {
    s.classList.remove('active');
    // מחכה לסיום האנימציה לפני הסרה מה-DOM
    setTimeout(() => { s.style.display = 'none'; }, 340);
  });

  _editingEntryId = null;
}

/** סגירה בלחיצה על הרקע (overlay) */
function handleSubScreenOverlayClick(event) {
  if (event.target.classList.contains('sub-screen')) {
    hideSubScreen();
  }
}

// ============================================================
//  פעולת אימון
// ============================================================

// דגל למניעת לחיצה כפולה
let _workoutLocked = false;

/** מטפל בלחיצה על "כן" – היה אימון היום */
function handleWorkout() {
  if (_workoutLocked) return;
  _workoutLocked = true;

  doWorkout();
  // שחרר אחרי 800ms למניעת double-tap
  setTimeout(() => { _workoutLocked = false; }, 800);
}

/** מטפל בלחיצה על "לא" – לא היה אימון היום */
function skipWorkout() {
  showToast('בסדר, לא נרשם אימון היום', 'info');
}

/** מבצע את פעולת האימון בפועל */
function doWorkout() {
  const price = state.workoutPrice;
  state.balance -= price;
  state.totalWorkouts += 1;

  addLogEntry({
    type: 'workout_done',
    title: 'אימון כושר',
    amount: -price,
    balanceAfter: state.balance,
    note: ''
  });

  saveState();
  updateHomeUI();
  showToast('האימון נרשם בהצלחה! 💪', 'success');
}

// ============================================================
//  הוספת כסף
// ============================================================
function addMoney() {
  const amountInput = document.getElementById('add-money-input');
  const noteInput   = document.getElementById('add-money-note');
  const amount = parseFloat(amountInput.value);

  if (!amount || amount <= 0 || isNaN(amount)) {
    showToast('יש להזין סכום חיובי', 'error');
    amountInput.focus();
    return;
  }

  state.balance += amount;

  addLogEntry({
    type: 'money_added',
    title: 'הוספת כסף',
    amount: amount,
    balanceAfter: state.balance,
    note: noteInput.value.trim()
  });

  saveState();
  updateHomeUI();
  hideSubScreen();
  showToast(`₪${formatNum(amount)} נוספו לקופה 💰`, 'success');
}

// ============================================================
//  קביעת יתרה ידנית
// ============================================================
function setBalance() {
  const amountInput = document.getElementById('set-balance-input');
  const noteInput   = document.getElementById('set-balance-note');
  const newBalance  = parseFloat(amountInput.value);

  if (isNaN(newBalance)) {
    showToast('יש להזין יתרה תקינה', 'error');
    amountInput.focus();
    return;
  }

  const oldBalance = state.balance;
  state.balance = newBalance;

  addLogEntry({
    type: 'balance_set',
    title: 'עדכון יתרה ידני',
    amount: newBalance - oldBalance,
    balanceAfter: newBalance,
    note: noteInput.value.trim() || `שונה מ-₪${formatNum(oldBalance)} ל-₪${formatNum(newBalance)}`
  });

  saveState();
  updateHomeUI();
  hideSubScreen();
  showToast('היתרה עודכנה ✅', 'success');
}

// ============================================================
//  עדכון מחיר אימון
// ============================================================
function updatePrice() {
  const input = document.getElementById('price-input');
  const newPrice = parseFloat(input.value);

  if (!newPrice || newPrice <= 0 || isNaN(newPrice)) {
    showToast('יש להזין מחיר חיובי', 'error');
    input.focus();
    return;
  }

  const oldPrice = state.workoutPrice;
  state.workoutPrice = newPrice;

  addLogEntry({
    type: 'price_changed',
    title: 'שינוי מחיר אימון',
    amount: 0,
    balanceAfter: state.balance,
    note: `מחיר שונה מ-₪${formatNum(oldPrice)} ל-₪${formatNum(newPrice)}`
  });

  saveState();
  updateHomeUI();
  showToast(`מחיר אימון עודכן ל-₪${formatNum(newPrice)}`, 'success');
}

// ============================================================
//  הגדרות התראות
// ============================================================

/** שומר הגדרות תזכורת */
async function saveNotificationSettings() {
  const timeInput = document.getElementById('reminder-time-input');
  const toggle    = document.getElementById('notifications-toggle');

  state.reminderTime        = timeInput.value || '09:00';
  state.notificationsEnabled = toggle.checked;

  if (state.notificationsEnabled) {
    const granted = await requestNotificationPermission();
    if (!granted) {
      state.notificationsEnabled = false;
      toggle.checked = false;
    }
  }

  saveState();
  setupReminderCheck();
  updateNotificationStatus();
  updateReminderStatus();
  showToast('הגדרות נשמרו', 'success');
}

/** מבקש הרשאת התראות מהדפדפן */
async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    updateNotificationStatus('התראות אינן נתמכות בדפדפן זה');
    return false;
  }

  if (Notification.permission === 'granted') {
    updateNotificationStatus('התראות מופעלות ✓');
    return true;
  }

  if (Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      updateNotificationStatus('התראות מופעלות ✓');
      return true;
    }
  }

  updateNotificationStatus('הגישה להתראות לא אושרה. שנה בהגדרות הדפדפן.');
  return false;
}

function updateNotificationStatus(msg) {
  const el = document.getElementById('notification-status');
  if (!el) return;

  if (msg) { el.textContent = msg; return; }

  if (!('Notification' in window)) {
    el.textContent = 'התראות אינן נתמכות';
  } else if (Notification.permission === 'granted') {
    el.textContent = state.notificationsEnabled ? 'התראות מופעלות ✓' : '';
  } else if (Notification.permission === 'denied') {
    el.textContent = 'הגישה להתראות נחסמה בדפדפן';
  } else {
    el.textContent = '';
  }
}

function updateReminderStatus() {
  const el = document.getElementById('reminder-status');
  if (!el) return;

  const details = state.lastReminderAt
    ? `נשלחה לאחרונה: ${formatDateTime(new Date(state.lastReminderAt))}`
    : 'עדיין לא נשלחה תזכורת.';

  el.textContent = `התזכורת נבדקת כשהאפליקציה פעילה או חוזרת לקדמה. ${details}`;
}

function updateNotificationLimitations() {
  const el = document.getElementById('notification-limitations');
  if (!el) return;

  el.textContent = 'ברקע אמיתי או במסך נעול iPhone עשוי להשהות את האפליקציה. כדי לקבל תזכורות ברקע נדרש Push אמיתי מהענן, לא רק טיימר מקומי.';
}

// ============================================================
//  תזכורת יומית
// ============================================================

/** מגדיר בדיקה תקופתית לתזכורת (כל דקה) */
function setupReminderCheck() {
  if (window._reminderInterval) clearInterval(window._reminderInterval);
  if (!state.notificationsEnabled) return;

  checkReminder(); // בדיקה מיידית
  window._reminderInterval = setInterval(checkReminder, 60_000);
}

/** בודק אם עכשיו זמן התזכורת ושולח אם צריך */
function checkReminder() {
  if (!state.notificationsEnabled) return;

  const now = new Date();
  const [h, m] = state.reminderTime.split(':').map(Number);
  const reminderTime = new Date();
  reminderTime.setHours(h, m, 0, 0);

  const todayKey  = now.toDateString();
  const legacyLastKey = localStorage.getItem('_last-reminder');
  const lastKey = state.lastReminderDateKey || legacyLastKey;
  const diffMs    = now - reminderTime;

  // שלח ברגע שעברנו את שעת התזכורת, גם אם ה-interval לא פגע בדיוק בדקה.
  if (diffMs >= 0 && lastKey !== todayKey) {
    localStorage.setItem('_last-reminder', todayKey);
    state.lastReminderDateKey = todayKey;
    sendReminder();
  }
}

/** שולח התראה (Service Worker אם אפשר, אחרת Notification/toast) */
async function sendReminder(isTest = false) {
  const title = 'כושר – תזכורת יומית';
  const body  = isTest ? 'זוהי תזכורת בדיקה כדי לוודא שהתראות פועלות.' : 'האם היה אימון כושר היום? 🏋️';

  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const registration = 'serviceWorker' in navigator
        ? await navigator.serviceWorker.getRegistration().catch(() => null)
        : null;

      if (registration?.showNotification) {
        await registration.showNotification(title, {
          body,
          icon: 'icons/icon.svg',
          badge: 'icons/icon.svg',
          tag: isTest ? 'fitness-test-reminder' : 'fitness-daily-reminder',
          renotify: true,
          dir: 'rtl',
          lang: 'he'
        });
      } else {
        new Notification(title, { body, icon: 'icons/icon.svg', dir: 'rtl', lang: 'he' });
      }
    } else {
      showToast(`${title}: ${body}`, 'info');
    }
  } catch {
    showToast(`${title}: ${body}`, 'info');
  }

  if (!isTest) {
    state.lastReminderAt = new Date().toISOString();
    updateReminderStatus();

    addLogEntry({
      type: 'reminder',
      title: 'תזכורת יומית',
      amount: 0,
      balanceAfter: state.balance,
      note: 'תזכורת יומית אוטומטית'
    });
    saveState();
    return;
  }

  updateNotificationStatus('תזכורת בדיקה נשלחה');
  showToast('תזכורת בדיקה נשלחה', 'success');
}

function sendTestReminder() {
  if (!state.notificationsEnabled) {
    showToast('יש להפעיל התראות קודם', 'warning');
    return;
  }

  sendReminder(true);
}

async function refreshFromPull() {
  if (_isPullRefreshing) return;

  _isPullRefreshing = true;
  setPullRefreshIndicator('מרענן נתונים...', true);

  try {
    await hydrateState();
    const registration = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration().catch(() => null)
      : null;
    await registration?.update?.();
    refreshAllUI();
    showToast('הנתונים עודכנו', 'success');
  } catch {
    showToast('לא ניתן היה לרענן כעת', 'error');
  } finally {
    _isPullRefreshing = false;
    setPullRefreshIndicator('משוך למטה כדי לרענן', false);
  }
}

function setPullRefreshIndicator(message, active, ready = false) {
  const indicator = document.getElementById('pull-refresh-indicator');
  if (!indicator) return;

  indicator.textContent = message;
  indicator.classList.toggle('visible', active || ready);
  indicator.classList.toggle('ready', ready);
  indicator.classList.toggle('refreshing', active);
}

function setupPullToRefresh() {
  const screen = document.getElementById('screen-home');
  if (!screen || screen.dataset.pullToRefreshReady === 'true') return;

  const stateRef = {
    startY: 0,
    deltaY: 0,
    dragging: false
  };

  screen.addEventListener('touchstart', event => {
    if (screen.scrollTop > 0 || event.touches.length !== 1 || _isPullRefreshing) return;
    stateRef.startY = event.touches[0].clientY;
    stateRef.deltaY = 0;
    stateRef.dragging = true;
  }, { passive: true });

  screen.addEventListener('touchmove', event => {
    if (!stateRef.dragging || event.touches.length !== 1) return;

    stateRef.deltaY = Math.max(0, event.touches[0].clientY - stateRef.startY);
    if (stateRef.deltaY <= 0 || screen.scrollTop > 0) return;

    const ready = stateRef.deltaY > 70;
    setPullRefreshIndicator(ready ? 'שחרר כדי לרענן' : 'משוך למטה כדי לרענן', true, ready);
    if (stateRef.deltaY > 6) {
      event.preventDefault();
    }
  }, { passive: false });

  screen.addEventListener('touchend', () => {
    if (!stateRef.dragging) return;

    const shouldRefresh = stateRef.deltaY > 70;
    stateRef.dragging = false;
    stateRef.deltaY = 0;

    if (shouldRefresh) {
      refreshFromPull();
      return;
    }

    setPullRefreshIndicator('משוך למטה כדי לרענן', false);
  });

  screen.dataset.pullToRefreshReady = 'true';
}

function refreshAllUI() {
  updateHomeUI();
  renderJournal();
  renderMonthlySummary();
  renderSettings();
  applyTheme(state.theme || 'light');
}

// ============================================================
//  לוג פעולות
// ============================================================

/** מוסיף רשומה ללוג */
function addLogEntry({ type, title, amount, balanceAfter, note }) {
  const now      = new Date();
  const dateStr  = now.toLocaleDateString('he-IL', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeStr  = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  state.logs.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    type,
    title,
    amount,
    balanceAfter,
    note: note || '',
    date: dateStr,
    time: timeStr,
    monthKey
  });
}

/** מרנדר את כל הלוג */
function renderJournal() {
  const container = document.getElementById('journal-container');
  if (!container) return;

  if (state.logs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <h3>היומן עדיין ריק</h3>
        <p>כאן יופיעו כל הפעולות שביצעת ועריכות שבוצעו</p>
      </div>`;
    return;
  }

  // קיבוץ לפי חודש
  const grouped = {};
  state.logs.forEach(entry => {
    if (!grouped[entry.monthKey]) grouped[entry.monthKey] = [];
    grouped[entry.monthKey].push(entry);
  });

  // מיון חודשים בסדר יורד
  const sortedMonths = Object.keys(grouped).sort().reverse();

  let html = '';
  sortedMonths.forEach(monthKey => {
    const [year, month] = monthKey.split('-');
    const label = new Date(year, Number(month) - 1, 1)
      .toLocaleDateString('he-IL', { year: 'numeric', month: 'long' });

    html += `<div class="log-month-header">${label}</div><div class="log-month-group">`;
    grouped[monthKey].forEach(entry => { html += buildJournalEntryHTML(entry); });
    html += `</div>`;
  });

  container.innerHTML = html;
}

/** בונה HTML לרשומת יומן בודדת */
function buildJournalEntryHTML(entry) {
  const CONFIG = {
    workout_done:  { icon: '🏋️', color: 'red',   label: 'אימון'          },
    money_added:   { icon: '💰', color: 'green', label: 'הוספת כסף'      },
    balance_set:   { icon: '✏️', color: 'blue',  label: 'עדכון יתרה'     },
    price_changed: { icon: '🏷️', color: 'blue',  label: 'שינוי מחיר'     },
    reminder:      { icon: '🔔', color: 'gray',  label: 'תזכורת'         },
    journal_edited:{ icon: '🧾', color: 'gray',  label: 'עריכת יומן'      },
    journal_deleted:{ icon: '🗑️', color: 'gray', label: 'מחיקת יומן'      },
  };

  const cfg = CONFIG[entry.type] || { icon: '📝', color: 'gray', label: entry.type };

  const amountHTML = entry.amount !== 0
    ? `<span class="amount ${entry.amount > 0 ? 'positive' : 'negative'}">${entry.amount > 0 ? '+' : ''}₪${formatNum(Math.abs(entry.amount))}</span>`
    : '';

  const noteHTML = entry.note
    ? `<div class="log-note">${escapeHTML(entry.note)}</div>`
    : '';

  const dateTimeHTML = `<div class="log-entry-datetime" dir="rtl"><span>${entry.date}</span><span>${entry.time}</span></div>`;

  const editButtonHTML = `
    <button
      class="journal-edit-btn"
      type="button"
      data-entry-id="${escapeHTML(entry.id)}"
      data-entry-title="${escapeHTML(entry.title)}"
      data-entry-amount="${escapeHTML(entry.amount)}"
      data-entry-note="${escapeHTML(entry.note || '')}"
      onclick="openEditEntryFromButton(this)">
      עריכה
    </button>`;

  return `
    <div class="log-entry">
      <div class="log-entry-icon log-icon-${cfg.color}">${cfg.icon}</div>
      <div class="log-entry-body">
        <div class="log-entry-title">${escapeHTML(entry.title)}</div>
        <div class="log-entry-meta">
          ${dateTimeHTML}
          ${noteHTML}
        </div>
        <div class="journal-entry-actions">${editButtonHTML}</div>
      </div>
      <div class="log-entry-amounts">
        ${amountHTML}
        <div class="log-balance-after">₪${formatNum(entry.balanceAfter)}</div>
      </div>
    </div>`;
}

function renderMonthlySummary() {
  const container = document.getElementById('monthly-summary-container');
  if (!container) return;

  if (state.logs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📆</div>
        <h3>אין עדיין נתונים חודשיים</h3>
        <p>ברגע שיתחילו להירשם אימונים, יופיע כאן סיכום חודשי מסודר</p>
      </div>`;
    return;
  }

  const currentMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const summaries = buildMonthlySummaries();

  container.innerHTML = summaries.map(summary => {
    const isCurrent = summary.monthKey === currentMonthKey;
    return `
      <div class="summary-month-card${isCurrent ? ' current' : ''}">
        <div class="summary-month-header-row">
          <div class="summary-month-title">${escapeHTML(summary.label)}</div>
          <div class="summary-month-badge">${isCurrent ? 'החודש' : 'סיכום'}</div>
        </div>
        <div class="summary-grid">
          <div class="summary-stat">
            <div class="summary-stat-value">${summary.workouts}</div>
            <div class="summary-stat-label">אימונים</div>
          </div>
          <div class="summary-stat">
            <div class="summary-stat-value">₪${formatNum(summary.spent)}</div>
            <div class="summary-stat-label">סה"כ ירד</div>
          </div>
          <div class="summary-stat">
            <div class="summary-stat-value">₪${formatNum(summary.added)}</div>
            <div class="summary-stat-label">סה"כ נוסף</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

function buildMonthlySummaries() {
  const grouped = new Map();

  state.logs.forEach(entry => {
    const monthKey = entry.monthKey || deriveMonthKeyFromDate(entry.date);
    if (!grouped.has(monthKey)) {
      const [year, month] = monthKey.split('-');
      grouped.set(monthKey, {
        monthKey,
        label: new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('he-IL', { year: 'numeric', month: 'long' }),
        workouts: 0,
        spent: 0,
        added: 0
      });
    }

    const target = grouped.get(monthKey);
    if (entry.type === 'workout_done') {
      target.workouts += 1;
      target.spent += Math.abs(Number(entry.amount) || 0);
    }
    if ((Number(entry.amount) || 0) > 0) {
      target.added += Number(entry.amount) || 0;
    }
  });

  return Array.from(grouped.values()).sort((left, right) => right.monthKey.localeCompare(left.monthKey));
}

function openEditEntryFromButton(button) {
  openEditEntry(
    button.dataset.entryId,
    button.dataset.entryTitle || '',
    Number(button.dataset.entryAmount) || 0,
    button.dataset.entryNote || ''
  );
}

function openEditEntry(entryId, entryTitle, entryAmount, entryNote) {
  const entry = state.logs.find(item => item.id === entryId);
  if (!entry) return;

  _editingEntryId = entryId;
  document.getElementById('edit-entry-title').value = entryTitle || entry.title || '';
  const amountInput = document.getElementById('edit-entry-amount');
  amountInput.value = Number.isFinite(entryAmount) ? entryAmount : (Number(entry.amount) || 0);
  amountInput.disabled = isZeroAmountEntry(entry);
  document.getElementById('edit-entry-note').value = entryNote || entry.note || '';
  showSubScreen('edit-entry', true);
}

function saveEditedEntry() {
  if (!_editingEntryId) return;

  const entry = state.logs.find(item => item.id === _editingEntryId);
  if (!entry) return;

  const titleInput = document.getElementById('edit-entry-title');
  const amountInput = document.getElementById('edit-entry-amount');
  const noteInput = document.getElementById('edit-entry-note');
  const parsedAmount = parseFloat(amountInput.value);
  const nextAmount = amountInput.disabled ? Number(entry.amount) || 0 : normalizeEntryAmount(entry.type, parsedAmount);

  if (!titleInput.value.trim() || Number.isNaN(nextAmount)) {
    showToast('יש למלא כותרת וסכום תקין', 'error');
    return;
  }

  const before = {
    title: entry.title,
    amount: entry.amount,
    note: entry.note
  };

  entry.title = titleInput.value.trim();
  entry.amount = nextAmount;
  entry.note = noteInput.value.trim();

  recalculateStateFromLogs();

  addLogEntry({
    type: 'journal_edited',
    title: 'נערכה רשומה ביומן',
    amount: 0,
    balanceAfter: state.balance,
    note: `"${before.title}" עודכנה: ₪${formatNum(before.amount)} -> ₪${formatNum(nextAmount)}`
  });

  recalculateStateFromLogs();
  saveState();
  refreshAllUI();
  hideSubScreen();
  showToast('הרשומה עודכנה', 'success');
}

function deleteEditedEntry() {
  if (!_editingEntryId) return;

  const entry = state.logs.find(item => item.id === _editingEntryId);
  if (!entry) return;

  showConfirm(
    'מחיקת רשומה',
    'הרשומה תימחק מהיומן. פעולת המחיקה עצמה תישמר ביומן הבקרה.',
    () => {
      const removedEntry = { ...entry };
      state.logs = state.logs.filter(item => item.id !== _editingEntryId);
      recalculateStateFromLogs();
      addLogEntry({
        type: 'journal_deleted',
        title: 'נמחקה רשומה מהיומן',
        amount: 0,
        balanceAfter: state.balance,
        note: `נמחקה הרשומה "${removedEntry.title}" בסכום ₪${formatNum(Math.abs(Number(removedEntry.amount) || 0))}`
      });
      recalculateStateFromLogs();
      saveState();
      refreshAllUI();
      hideSubScreen();
      showToast('הרשומה נמחקה', 'warning');
    }
  );
}

function recalculateStateFromLogs() {
  let runningBalance = 0;
  let workoutCount = 0;
  const ordered = [...state.logs].reverse();

  ordered.forEach(entry => {
    entry.monthKey = deriveMonthKeyFromDate(entry.date);
    runningBalance += Number(entry.amount) || 0;
    entry.balanceAfter = runningBalance;
    if (entry.type === 'workout_done') {
      workoutCount += 1;
    }
  });

  state.balance = runningBalance;
  state.totalWorkouts = workoutCount;
}

function isZeroAmountEntry(entry) {
  return ['reminder', 'journal_edited', 'price_changed'].includes(entry.type) || (Number(entry.amount) || 0) === 0;
}

function normalizeEntryAmount(type, amount) {
  if (Number.isNaN(amount)) return amount;
  if (type === 'workout_done') return -Math.abs(amount);
  if (type === 'money_added') return Math.abs(amount);
  if (['reminder', 'journal_edited', 'price_changed'].includes(type)) return 0;
  return amount;
}

function deriveMonthKeyFromDate(dateStr) {
  if (typeof dateStr !== 'string') {
    return `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  }

  const parts = dateStr.split(/[./-]/).map(part => part.trim());
  if (parts.length !== 3) {
    return `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  }

  const [day, month, year] = parts;
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ============================================================
//  רינדור הגדרות
// ============================================================
function renderSettings() {
  const priceInput = document.getElementById('price-input');
  const timeInput  = document.getElementById('reminder-time-input');
  const toggle     = document.getElementById('notifications-toggle');
  const themeToggle = document.getElementById('theme-toggle');

  if (priceInput) priceInput.value = state.workoutPrice;
  if (timeInput)  timeInput.value  = state.reminderTime;
  if (toggle)     toggle.checked   = state.notificationsEnabled;
  if (themeToggle) themeToggle.checked = (state.theme || 'light') === 'dark';

  // הודעת iOS
  const iosNotice = document.getElementById('ios-pwa-notice');
  if (iosNotice) iosNotice.style.display = isIOS() ? 'block' : 'none';

  updateNotificationStatus();
  updateReminderStatus();
  updateNotificationLimitations();
  updateCloudSyncStatus();
}

function applyTheme(theme) {
  const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
  state.theme = normalizedTheme;
  document.documentElement.setAttribute('data-theme', normalizedTheme);
  const themeMeta = document.getElementById('theme-color-meta');
  if (themeMeta) {
    themeMeta.setAttribute('content', THEME_META_COLORS[normalizedTheme]);
  }
}

function toggleThemeSetting() {
  const themeToggle = document.getElementById('theme-toggle');
  const nextTheme = themeToggle?.checked ? 'dark' : 'light';
  applyTheme(nextTheme);
  saveState();
  showToast(nextTheme === 'dark' ? 'מצב לילה הופעל' : 'מצב בהיר הופעל', 'success');
}

// ============================================================
//  ייצוא / ייבוא
// ============================================================

/** מייצא גיבוי TXT */
function exportData() {
  const date = new Date().toISOString().split('T')[0];
  const lines = [];

  lines.push('===== גיבוי כושר =====');
  lines.push(`תאריך: ${date}`);
  lines.push('');
  lines.push(`יתרה: ₪${formatNum(state.balance)}`);
  lines.push(`מחיר אימון: ₪${formatNum(state.workoutPrice)}`);
  lines.push(`סה"כ אימונים: ${state.totalWorkouts}`);
  lines.push('');
  lines.push('===== לוג פעולות =====');
  state.logs.forEach(entry => {
    const amountStr = entry.amount !== 0 ? ` | ${entry.amount > 0 ? '+' : ''}₪${formatNum(entry.amount)}` : '';
    const noteStr   = entry.note ? ` | ${entry.note}` : '';
    lines.push(`${entry.date} ${entry.time} | ${entry.title}${amountStr} | יתרה: ₪${formatNum(entry.balanceAfter)}${noteStr}`);
  });
  lines.push('');
  lines.push('===== נתונים גולמיים (לייבוא) =====');
  lines.push(JSON.stringify(state));

  const content = lines.join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);

  const a    = document.createElement('a');
  a.href     = url;
  a.download = `fitness-backup-${date}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('גיבוי יוצא בהצלחה 📤', 'success');
}

/** פותח דיאלוג בחירת קובץ */
function triggerImport() {
  document.getElementById('import-file-input').click();
}

/** מייבא גיבוי TXT */
function importData(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const text = e.target.result;
      // חיפוש השורה עם ה-JSON הגולמי (השורה האחרונה שאינה ריקה לאחר הכותרת)
      const rawLine = text.split('\n').find(line => line.trim().startsWith('{'));
      if (!rawLine) {
        showToast('קובץ גיבוי לא תקין', 'error');
        return;
      }
      const imported = JSON.parse(rawLine.trim());

      // ולידציה בסיסית
      if (typeof imported.balance !== 'number' || !Array.isArray(imported.logs)) {
        showToast('קובץ גיבוי לא תקין', 'error');
        return;
      }

      state = { ...DEFAULT_STATE, ...imported };
      recalculateStateFromLogs();
      applyTheme(state.theme || 'light');
      saveState();
      refreshAllUI();
      showToast('גיבוי יובא בהצלחה 📥', 'success');
    } catch {
      showToast('שגיאה בייבוא הגיבוי', 'error');
    }
  };
  reader.readAsText(file);
  // מאפס כדי שניתן לייבא אותו קובץ פעמיים
  event.target.value = '';
}

// ============================================================
//  איפוס נתונים (אישור כפול)
// ============================================================
function resetData() {
  showConfirm(
    'איפוס נתונים',
    'כל הנתונים יימחקו לצמיתות. פעולה זו אינה הפיכה. האם להמשיך?',
    () => {
      state = { ...DEFAULT_STATE };
      localStorage.removeItem('_last-reminder');
      applyTheme(state.theme);
      saveState();
      refreshAllUI();
      showScreen('home');
      showToast('כל הנתונים אופסו', 'warning');
    }
  );
}

// ============================================================
//  עדכון UI – מסך הבית
// ============================================================
function updateHomeUI() {
  const balanceDisplay   = document.getElementById('balance-display');
  const balanceMeta      = document.getElementById('balance-meta');
  const totalWorkouts    = document.getElementById('total-workouts-display');
  const remainingDisplay = document.getElementById('remaining-workouts-display');
  const summaryText      = document.getElementById('summary-text');

  if (!balanceDisplay) return;

  const { balance, workoutPrice: price, totalWorkouts: workoutCount } = state;
  const remaining = price > 0 ? Math.floor(balance / price) : 0;

  // יתרה
  balanceDisplay.textContent = `₪${formatNum(balance)}`;
  balanceDisplay.className   = `balance-amount${balance < 0 ? ' negative' : ''}`;

  // מטא
  if (balance < 0) {
    balanceMeta.textContent = `מינוס של ₪${formatNum(Math.abs(balance))}`;
    balanceMeta.className   = 'balance-meta negative';
  } else if (balance === 0) {
    balanceMeta.textContent = 'הקופה ריקה';
    balanceMeta.className   = 'balance-meta';
  } else {
    balanceMeta.textContent = `מחיר אימון: ₪${formatNum(price)}`;
    balanceMeta.className   = 'balance-meta';
  }

  // סטטיסטיקות
  totalWorkouts.textContent    = workoutCount;
  remainingDisplay.textContent = remaining > 0 ? remaining : 0;

  // תקציר
  if (balance <= 0) {
    summaryText.textContent = 'יש להוסיף כסף לקופה כדי לרשום אימונים';
    summaryText.className   = 'summary-card warning';
  } else if (remaining <= 1) {
    summaryText.textContent = remaining === 1
      ? 'נשאר אימון אחד בקופה – כדאי לחדש'
      : 'הוסף כסף לקופה לאימון הבא';
    summaryText.className = 'summary-card warning';
  } else {
    summaryText.textContent = `ביצעת ${workoutCount} אימונים. נשארו ${remaining} אימונים ביתרה.`;
    summaryText.className   = 'summary-card';
  }
}

// ============================================================
//  Toast
// ============================================================
let _toastTimer;

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  clearTimeout(_toastTimer);
  toast.textContent = message;
  toast.className   = `toast toast-${type} show`;

  _toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

// ============================================================
//  דיאלוג אישור
// ============================================================
let _confirmOkCb     = null;
let _confirmCancelCb = null;

function showConfirm(title, message, onOk, onCancel) {
  const overlay  = document.getElementById('confirm-overlay');
  const titleEl  = document.getElementById('confirm-title');
  const msgEl    = document.getElementById('confirm-message');

  if (!overlay) return;

  titleEl.textContent = title;
  msgEl.textContent   = message;
  _confirmOkCb        = onOk || null;
  _confirmCancelCb    = onCancel || null;

  overlay.style.display = 'flex';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => overlay.classList.add('show'));
  });
}

function confirmOk() {
  _closeConfirm();
  if (_confirmOkCb) { const cb = _confirmOkCb; _confirmOkCb = null; cb(); }
}

function confirmCancel() {
  _closeConfirm();
  if (_confirmCancelCb) { const cb = _confirmCancelCb; _confirmCancelCb = null; cb(); }
  // שחרר נעילת אימון אם הדיאלוג נפתח ממנה
  _workoutLocked = false;
}

function _closeConfirm() {
  const overlay = document.getElementById('confirm-overlay');
  if (!overlay) return;
  overlay.classList.remove('show');
  setTimeout(() => { overlay.style.display = 'none'; }, 280);
}

// ============================================================
//  יצירת אייקון canvas לאפל (apple-touch-icon)
// ============================================================

/** מצייר דמבל פשוט על canvas ומחזיר data-URL */
function generateCanvasIcon(size) {
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // רקע כחול עגול
  const r = size * 0.22;
  ctx.fillStyle = '#007AFF';
  ctx.beginPath();
  _roundRectPath(ctx, 0, 0, size, size, r);
  ctx.fill();

  // דמבל (scaled from 100×100)
  ctx.fillStyle = 'white';
  const s = size / 100;

  _fillRoundRect(ctx, 4*s,  38*s, 6*s,  24*s, 3*s); // צלחת שמאל
  _fillRoundRect(ctx, 10*s, 33*s, 14*s, 34*s, 4*s); // משקולת שמאל
  _fillRoundRect(ctx, 24*s, 44*s, 52*s, 12*s, 3*s); // מוט
  _fillRoundRect(ctx, 76*s, 33*s, 14*s, 34*s, 4*s); // משקולת ימין
  _fillRoundRect(ctx, 90*s, 38*s, 6*s,  24*s, 3*s); // צלחת ימין

  return canvas.toDataURL('image/png');
}

function _roundRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function _fillRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  _roundRectPath(ctx, x, y, w, h, r);
  ctx.fill();
}

// ============================================================
//  עזרים
// ============================================================

/** מעצב מספר לעברית – ₪1,234 */
function formatNum(n) {
  if (typeof n !== 'number' || isNaN(n)) return '0';
  return Math.round(n).toLocaleString('he-IL');
}

function formatDateTime(date) {
  if (!(date instanceof Date) || isNaN(date)) return '-';
  return date.toLocaleString('he-IL', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** מגן מפני XSS */
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** זיהוי iOS */
function isIOS() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

// ============================================================
//  רישום Service Worker
// ============================================================
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('sw.js')
      .then(reg => console.log('[FitnessTracker] SW registered, scope:', reg.scope))
      .catch(err => console.warn('[FitnessTracker] SW registration failed:', err));
  }
}

// ============================================================
//  Enter Key – שדות קלט
// ============================================================
function setupKeyboardHandlers() {
  document.getElementById('add-money-input')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') addMoney(); });
  document.getElementById('add-money-note')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') addMoney(); });

  document.getElementById('set-balance-input')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') setBalance(); });
  document.getElementById('set-balance-note')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') setBalance(); });

  document.getElementById('edit-entry-title')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') saveEditedEntry(); });
  document.getElementById('edit-entry-amount')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') saveEditedEntry(); });
  document.getElementById('edit-entry-note')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') saveEditedEntry(); });
}

// ============================================================
//  אתחול
// ============================================================
async function init() {
  // טוען state מהשרת (עם fallback ללוקאלי)
  await hydrateState();
  recalculateStateFromLogs();
  applyTheme(state.theme || 'light');

  // עדכון UI ראשוני
  refreshAllUI();

  // apple-touch-icon דינמי
  try {
    const iconDataURL = generateCanvasIcon(192);
    const link = document.getElementById('apple-touch-icon');
    if (link) link.href = iconDataURL;
  } catch (e) {
    console.warn('[FitnessTracker] Canvas icon generation failed:', e);
  }

  // הגדרת בדיקת תזכורת
  setupReminderCheck();

  // רישום Service Worker
  registerServiceWorker();

  // מקשי Enter
  setupKeyboardHandlers();

  // רענון במשיכה על מסך הבית
  setupPullToRefresh();

  // בדיקה חוזרת כשחוזרים לאפליקציה
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkReminder();
  });
  window.addEventListener('focus', checkReminder);

}

document.addEventListener('DOMContentLoaded', init);
