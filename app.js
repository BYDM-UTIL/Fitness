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
  totalWorkouts: 0,
  logs: []
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
  if (name === 'log') renderLog();
  if (name === 'settings') renderSettings();
}

/** מציג bottom-sheet (add-money / set-balance) */
function showSubScreen(name) {
  // סגור כל bottom-sheet פתוח
  document.querySelectorAll('.sub-screen').forEach(s => {
    s.style.display = 'none';
    s.classList.remove('active');
  });

  const target = document.getElementById(`sub-screen-${name}`);
  if (!target) return;

  // ניקוי שדות
  target.querySelectorAll('input[type="number"], input[type="text"]').forEach(inp => {
    inp.value = '';
  });

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
function saveNotificationSettings() {
  const timeInput = document.getElementById('reminder-time-input');
  const toggle    = document.getElementById('notifications-toggle');

  state.reminderTime        = timeInput.value || '09:00';
  state.notificationsEnabled = toggle.checked;

  if (state.notificationsEnabled) {
    requestNotificationPermission().then(granted => {
      if (!granted) {
        state.notificationsEnabled = false;
        toggle.checked = false;
        saveState();
      }
    });
  }

  saveState();
  setupReminderCheck();
  updateNotificationStatus();
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
  const lastKey   = localStorage.getItem('_last-reminder');
  const diffMs    = now - reminderTime;

  // שלח אם חלפנו את שעת התזכורת באותה דקה ולא שלחנו היום
  if (diffMs >= 0 && diffMs < 60_000 && lastKey !== todayKey) {
    localStorage.setItem('_last-reminder', todayKey);
    sendReminder();
  }
}

/** שולח התראה (push אם אפשר, אחרת toast) */
function sendReminder() {
  const title = 'כושר – תזכורת יומית';
  const body  = 'האם היה אימון כושר היום? 🏋️';

  if ('Notification' in window && Notification.permission === 'granted') {
    // התראת push אמיתית
    // TODO: בעתיד – להחליף ב-Firebase Cloud Messaging (FCM)
    // fcm.sendNotification({ title, body, icon: 'icons/icon-192.png' });
    new Notification(title, { body, icon: 'icons/icon.svg' });
  } else {
    // fallback – toast פנימי
    showToast(`${title}: ${body}`, 'info');
  }

  // רישום בלוג
  addLogEntry({
    type: 'reminder',
    title: 'תזכורת יומית',
    amount: 0,
    balanceAfter: state.balance,
    note: 'תזכורת יומית אוטומטית'
  });
  saveState();
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
function renderLog() {
  const container = document.getElementById('log-container');
  if (!container) return;

  if (state.logs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <h3>אין פעולות עדיין</h3>
        <p>כאן יופיעו כל הפעולות שביצעת</p>
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
    grouped[monthKey].forEach(entry => { html += buildLogEntryHTML(entry); });
    html += `</div>`;
  });

  container.innerHTML = html;
}

/** בונה HTML לרשומת לוג בודדת */
function buildLogEntryHTML(entry) {
  const CONFIG = {
    workout_done:  { icon: '🏋️', color: 'red',   label: 'אימון'          },
    money_added:   { icon: '💰', color: 'green', label: 'הוספת כסף'      },
    balance_set:   { icon: '✏️', color: 'blue',  label: 'עדכון יתרה'     },
    price_changed: { icon: '🏷️', color: 'blue',  label: 'שינוי מחיר'     },
    reminder:      { icon: '🔔', color: 'gray',  label: 'תזכורת'         },
  };

  const cfg = CONFIG[entry.type] || { icon: '📝', color: 'gray', label: entry.type };

  const amountHTML = entry.amount !== 0
    ? `<span class="amount ${entry.amount > 0 ? 'positive' : 'negative'}">${entry.amount > 0 ? '+' : ''}₪${formatNum(Math.abs(entry.amount))}</span>`
    : '';

  const noteHTML = entry.note
    ? `<span class="log-note">${escapeHTML(entry.note)}</span>`
    : '';

  return `
    <div class="log-entry">
      <div class="log-entry-icon log-icon-${cfg.color}">${cfg.icon}</div>
      <div class="log-entry-body">
        <div class="log-entry-title">${escapeHTML(entry.title)}</div>
        <div class="log-entry-meta">
          <span>${entry.date}</span>
          <span>${entry.time}</span>
          ${noteHTML}
        </div>
      </div>
      <div class="log-entry-amounts">
        ${amountHTML}
        <div class="log-balance-after">₪${formatNum(entry.balanceAfter)}</div>
      </div>
    </div>`;
}

// ============================================================
//  רינדור הגדרות
// ============================================================
function renderSettings() {
  const priceInput = document.getElementById('price-input');
  const timeInput  = document.getElementById('reminder-time-input');
  const toggle     = document.getElementById('notifications-toggle');

  if (priceInput) priceInput.value = state.workoutPrice;
  if (timeInput)  timeInput.value  = state.reminderTime;
  if (toggle)     toggle.checked   = state.notificationsEnabled;

  // הודעת iOS
  const iosNotice = document.getElementById('ios-pwa-notice');
  if (iosNotice) iosNotice.style.display = isIOS() ? 'block' : 'none';

  updateNotificationStatus();
  updateCloudSyncStatus();
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
      saveState();
      updateHomeUI();
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
    'כל הנתונים יימחקו לצמיתות. האם להמשיך?',
    () => {
      showConfirm(
        'אישור סופי',
        'פעולה זו בלתי הפיכה לחלוטין. למחוק הכל?',
        () => {
          state = { ...DEFAULT_STATE };
          localStorage.removeItem('_last-reminder');
          saveState();
          updateHomeUI();
          showScreen('home');
          showToast('כל הנתונים אופסו', 'warning');
        }
      );
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
}

// ============================================================
//  אתחול
// ============================================================
async function init() {
  // טוען state מהשרת (עם fallback ללוקאלי)
  await hydrateState();

  // עדכון UI ראשוני
  updateHomeUI();

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

  // תזכורת כשהאפליקציה נפתחה אחרי שעת התזכורת
  if (state.notificationsEnabled) {
    const now = new Date();
    const [h, m] = state.reminderTime.split(':').map(Number);
    const reminderTime = new Date();
    reminderTime.setHours(h, m, 0, 0);
    const todayKey = now.toDateString();
    const lastKey  = localStorage.getItem('_last-reminder');

    if (now > reminderTime && lastKey !== todayKey) {
      setTimeout(() => {
        showToast('תזכורת: האם היה אימון כושר היום? 🏋️', 'info');
      }, 1500);
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
